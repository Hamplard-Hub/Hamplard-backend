// webhook-signature.middleware.ts
// Verifies HMAC-SHA256 signatures on inbound webhook requests.
//
// How it works:
//   1. Reads the raw request body (requires { rawBody: true } in NestFactory.create).
//   2. Computes HMAC-SHA256 of that raw body using WEBHOOK_SECRET from env.
//   3. Compares against the signature sent in the X-Webhook-Signature header
//      using timing-safe comparison to prevent timing attacks.
//   4. Rejects with 401 if absent, or 403 if present but invalid.
//
// The middleware applies only to routes under /api/v1/webhooks/* (registered
// in AppModule). Individual routes can opt out via @SkipWebhookSignature().
//
// Supported signature formats:
//   X-Webhook-Signature: sha256=<hex>   (GitHub-style, preferred)
//   X-Webhook-Signature: <hex>          (plain hex fallback)
//
// Multiple provider secrets can be configured via WEBHOOK_SECRET_<NAME>
// (e.g. WEBHOOK_SECRET_STRIPE, WEBHOOK_SECRET_AFRICASTALKING). If a provider-
// specific secret exists it is tried first; the default WEBHOOK_SECRET is the
// fallback. This lets you rotate secrets per-provider without touching the
// others.

import {
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

import { SKIP_WEBHOOK_SIGNATURE_KEY } from '../decorators/skip-webhook-signature.decorator';

/** Header names checked in order of preference. */
const SIGNATURE_HEADERS = [
  'x-webhook-signature',     // Hamplard default / generic providers
  'x-hub-signature-256',     // GitHub / Meta
  'stripe-signature',        // Stripe (prefix format differs — handled below)
] as const;

/**
 * Strips the "sha256=" prefix used by GitHub-style providers and returns
 * only the hex portion. Returns the original string unchanged if no prefix.
 */
function extractHex(raw: string): string {
  return raw.startsWith('sha256=') ? raw.slice(7) : raw;
}

/**
 * Stripe sends a compound header: "t=<timestamp>,v1=<hex>,v1=<hex>".
 * Extract the first v1= value for comparison.
 */
function extractStripeHex(raw: string): string | null {
  const match = /v1=([0-9a-f]+)/.exec(raw);
  return match ? match[1] : null;
}

/**
 * Timing-safe hex comparison. Returns false if lengths differ (which would
 * ordinarily short-circuit, leaking information).
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

@Injectable()
export class WebhookSignatureMiddleware implements NestMiddleware {
  private readonly logger = new Logger(WebhookSignatureMiddleware.name);

  /** Default secret — used when no provider-specific key matches. */
  private readonly defaultSecret: string | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.defaultSecret = this.config.get<string>('WEBHOOK_SECRET');

    if (!this.defaultSecret) {
      this.logger.warn(
        'WEBHOOK_SECRET is not set. All webhook requests will be rejected ' +
          'unless a provider-specific WEBHOOK_SECRET_<NAME> is configured.',
      );
    }
  }

  use(req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) {
    // ------------------------------------------------------------------ //
    // 1. Find the incoming signature header.
    // ------------------------------------------------------------------ //
    let rawSignature: string | undefined;
    let isStripe = false;

    for (const header of SIGNATURE_HEADERS) {
      const value = req.headers[header];
      if (typeof value === 'string' && value.length > 0) {
        rawSignature = value;
        isStripe = header === 'stripe-signature';
        break;
      }
    }

    if (!rawSignature) {
      this.logger.warn(
        `Webhook request missing signature header — ${req.method} ${req.originalUrl}`,
      );
      throw new UnauthorizedException(
        'Webhook signature is required. Include a valid X-Webhook-Signature header.',
      );
    }

    // ------------------------------------------------------------------ //
    // 2. Determine which secret to use.
    //    The URL path segment after /webhooks/ is treated as the provider
    //    name, e.g. /api/v1/webhooks/stripe → look for WEBHOOK_SECRET_STRIPE.
    // ------------------------------------------------------------------ //
    const provider = this.resolveProvider(req.originalUrl);
    const secret = provider
      ? (this.config.get<string>(`WEBHOOK_SECRET_${provider.toUpperCase()}`) ??
          this.defaultSecret)
      : this.defaultSecret;

    if (!secret) {
      this.logger.error(
        `No webhook secret configured for provider="${provider ?? 'default'}". ` +
          `Set WEBHOOK_SECRET${provider ? `_${provider.toUpperCase()}` : ''} in your environment.`,
      );
      throw new ForbiddenException('Webhook endpoint is not configured.');
    }

    // ------------------------------------------------------------------ //
    // 3. Require a raw body — needs { rawBody: true } in NestFactory.create.
    // ------------------------------------------------------------------ //
    if (!req.rawBody || req.rawBody.length === 0) {
      this.logger.error(
        'rawBody is unavailable. Ensure NestFactory.create is called with ' +
          '{ rawBody: true } in main.ts.',
      );
      // Treat as a server configuration problem, not a client error.
      throw new ForbiddenException(
        'Webhook signature verification is misconfigured on the server.',
      );
    }

    // ------------------------------------------------------------------ //
    // 4. Compute expected HMAC and compare.
    // ------------------------------------------------------------------ //
    const expectedHex = createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    let receivedHex: string | null;

    if (isStripe) {
      // Stripe uses "t=<ts>,v1=<hex>" — extract the v1 part.
      receivedHex = extractStripeHex(rawSignature);
    } else {
      receivedHex = extractHex(rawSignature);
    }

    if (!receivedHex || !safeCompare(expectedHex, receivedHex)) {
      this.logger.warn(
        `Invalid webhook signature — provider="${provider ?? 'default'}" ` +
          `method=${req.method} path=${req.originalUrl}`,
      );
      throw new ForbiddenException(
        'Webhook signature verification failed. The request body or secret may be incorrect.',
      );
    }

    this.logger.debug(
      `Webhook signature verified — provider="${provider ?? 'default'}" path=${req.originalUrl}`,
    );

    next();
  }

  /**
   * Extracts the provider slug from the URL path.
   * /api/v1/webhooks/stripe/... → "stripe"
   * /api/v1/webhooks/...        → null (use default secret)
   */
  private resolveProvider(url: string): string | null {
    // Strip query string
    const path = url.split('?')[0];
    // Match the segment immediately after /webhooks/
    const match = /\/webhooks\/([^/]+)/.exec(path);
    return match ? match[1].toLowerCase() : null;
  }
}
