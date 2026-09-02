// skip-webhook-signature.decorator.ts
// Route-level opt-out from WebhookSignatureMiddleware.
//
// Usage — on a controller method that handles an unauthenticated health-check
// or test-ping endpoint within the /webhooks prefix:
//
//   @Post('webhooks/ping')
//   @SkipWebhookSignature()
//   handlePing() { return { ok: true }; }
//
// Note: because NestJS middleware runs before guards and interceptors, this
// decorator cannot be read by the middleware directly via Reflector (the
// execution context is not available at that stage). Instead, the middleware
// checks for a custom request property set by a lightweight guard that runs
// before it. See WebhookSkipGuard for the guard counterpart.
//
// For most webhook routes you will NOT need this decorator — only use it for
// provider health-check / handshake endpoints that explicitly send no
// signature (e.g. SendGrid event test pings, Stripe webhook verification GETs).

import { SetMetadata } from '@nestjs/common';

export const SKIP_WEBHOOK_SIGNATURE_KEY = 'skipWebhookSignature';

/**
 * Marks a route as exempt from HMAC signature verification.
 * Must be paired with WebhookSkipGuard being applied on the controller
 * (or globally) so the middleware can detect the opt-out at runtime.
 */
export const SkipWebhookSignature = () =>
  SetMetadata(SKIP_WEBHOOK_SIGNATURE_KEY, true);
