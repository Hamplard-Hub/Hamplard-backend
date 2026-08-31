// webhook-skip.guard.ts
// Companion guard for @SkipWebhookSignature().
//
// Since NestJS middleware runs BEFORE guards and cannot read route-level
// metadata via Reflector, the opt-out mechanism works in two stages:
//
//  Stage 1 — middleware (webhook-signature.middleware.ts):
//    Checks req['_webhookSignatureVerified']. If it is already set to true
//    the middleware skips (the guard already cleared the route). If the
//    property is missing, normal HMAC verification proceeds.
//
//  Stage 2 — this guard (applied at the controller class or method level):
//    When @SkipWebhookSignature() is present on the handler, the guard sets
//    req['_webhookSignatureSkipped'] = true so the middleware knows to pass
//    the request through on subsequent middleware execution if the framework
//    ever re-enters the middleware chain (defensive).
//
// In practice, the simplest and most reliable pattern is:
//
//   Option A (recommended): Don't put unsigned routes inside /webhooks/*.
//     Use a separate path prefix for health-check endpoints that isn't
//     covered by the middleware's forRoutes() registration.
//
//   Option B: Apply @SkipWebhookSignature() AND exclude that specific path
//     from the middleware registration using .exclude() in AppModule:
//
//       consumer
//         .apply(WebhookSignatureMiddleware)
//         .exclude('/api/v1/webhooks/ping')   // ← exact path exclusion
//         .forRoutes('webhooks');
//
// Option B is shown in AppModule. This guard is provided as a programmatic
// alternative when dynamic exclusion is needed at the route level.

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { SKIP_WEBHOOK_SIGNATURE_KEY } from '../decorators/skip-webhook-signature.decorator';

@Injectable()
export class WebhookSkipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_WEBHOOK_SIGNATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skip) {
      const req = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
      req['_webhookSignatureSkipped'] = true;
    }

    // This guard never blocks — it only stamps the request for informational use.
    return true;
  }
}
