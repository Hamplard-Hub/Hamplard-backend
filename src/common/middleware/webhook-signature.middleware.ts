// webhook-signature.middleware.ts
// Verifies HMAC-SHA256 signatures on inbound webhook requests.
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
import { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { getNumberConfig } from '../config/env.util';

/** Header names checked in order of preference. */
const SIGNATURE_HEADERS = [
  'x-webhook-signature',     // Hamplard default / generic providers
  'x-hub-signature-256',     // GitHub / Meta
  'stripe-signature',        // Stripe (prefix format differs — handled below)
] as const;

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Strips the "sha256=" prefix used by GitHub-style providers and returns
 * only the hex portion. Returns the original string unchanged if no prefix.
 */
function extractHex(raw: string): string {
  return raw.startsWith('sha256=') ? raw.slice(7) : raw;
}

export function parseStripeSignature(raw: string): {
  timestamp: string;
  signatures: string[];
} | null {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

export function parseGenericTimestampedSignature(raw: string): {
  timestamp: string;
  signatures: string[];
} | null {
  if (!raw.includes('t=')) return null;
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') timestamp = value;
    if ((key === 'v1' || key === 'sha256') && value) {
      signatures.push(extractHex(value));
    }
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
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

function hmacHex(secret: string, payload: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function signedPayload(timestamp: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
}

@Injectable()
export class WebhookSignatureMiddleware implements NestMiddleware {
  private readonly logger = new Logger(WebhookSignatureMiddleware.name);

  /** Default secret — used when no provider-specific key matches. */
  private readonly defaultSecret: string | undefined;
  private readonly stripeToleranceSeconds: number;
  private readonly genericToleranceSeconds: number;
  private readonly excludePrefixes: string[];

  constructor(private readonly config: ConfigService) {
    this.defaultSecret = this.config.get<string>('WEBHOOK_SECRET');

    this.stripeToleranceSeconds = this.readTolerance(
      'WEBHOOK_STRIPE_TOLERANCE_SECONDS',
    );
    this.genericToleranceSeconds = this.readTolerance(
      'WEBHOOK_TOLERANCE_SECONDS',
    );

    const excludeRaw =
      this.config.get<string>('WEBHOOK_SIGNATURE_EXCLUDE_PATHS', 'webhooks/ping') ??
      'webhooks/ping';
    this.excludePrefixes = excludeRaw
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => (path.startsWith('/') ? path : `/${path}`));

    if (!this.defaultSecret) {
      this.logger.warn(
        'WEBHOOK_SECRET is not set. All webhook requests will be rejected ' +
          'unless a provider-specific WEBHOOK_SECRET_<NAME> is configured.',
      );
    }
  }

  use(req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) {
    const path = (req.originalUrl ?? '').split('?')[0];
    if (
      this.excludePrefixes.some(
        (prefix) =>
          path === prefix ||
          path.endsWith(prefix) ||
          path.startsWith(`${prefix}/`),
      )
    ) {
      return next();
    }

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

    if (!req.rawBody || req.rawBody.length === 0) {
      this.logger.error(
        'rawBody is unavailable. Ensure NestFactory.create is called with ' +
          '{ rawBody: true } in main.ts.',
      );
      throw new ForbiddenException(
        'Webhook signature verification is misconfigured on the server.',
      );
    }

    const verified = isStripe
      ? this.verifyStripe(rawSignature, secret, req.rawBody)
      : this.verifyGeneric(rawSignature, secret, req.rawBody);

    if (!verified) {
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

  private verifyStripe(header: string, secret: string, rawBody: Buffer): boolean {
    const parsed = parseStripeSignature(header);
    if (!parsed) return false;
    if (!this.isFresh(parsed.timestamp, this.stripeToleranceSeconds)) return false;
    const expected = hmacHex(secret, signedPayload(parsed.timestamp, rawBody));
    return parsed.signatures.some((sig) => safeCompare(expected, sig));
  }

  private verifyGeneric(header: string, secret: string, rawBody: Buffer): boolean {
    const timestamped = parseGenericTimestampedSignature(header);
    if (timestamped) {
      if (!this.isFresh(timestamped.timestamp, this.genericToleranceSeconds)) {
        return false;
      }
      const expected = hmacHex(secret, signedPayload(timestamped.timestamp, rawBody));
      return timestamped.signatures.some((sig) => safeCompare(expected, sig));
    }

    const receivedHex = extractHex(header);
    if (!receivedHex) return false;
    const expectedHex = hmacHex(secret, rawBody);
    return safeCompare(expectedHex, receivedHex);
  }

  private isFresh(timestamp: string, toleranceSeconds: number): boolean {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
    return age <= toleranceSeconds;
  }

  /**
   * Invalid or negative tolerance must not disable verification.
   */
  private readTolerance(key: string): number {
    const value = getNumberConfig(this.config, key, DEFAULT_TOLERANCE_SECONDS);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_TOLERANCE_SECONDS;
    return value;
  }

  /**
   * Extracts the provider slug from the URL path.
   * /api/v1/webhooks/stripe/... → "stripe"
   * /api/v1/webhooks/...        → null (use default secret)
   */
  private resolveProvider(url: string): string | null {
    const path = url.split('?')[0];
    const match = /\/webhooks\/([^/]+)/.exec(path);
    return match ? match[1].toLowerCase() : null;
  }
}
