// role-throttler.guard.ts
// Issue #72 — differentiated throttling policy per authenticated role.
//
// Buckets: anon:<ip> (strictest), student:<id>, instructor:<id>, admin:<id>.
// Limits are env-tunable per bucket; every response carries X-RateLimit-*
// status headers and a rejected request gets 429 + Retry-After.
//
// Note: implemented as a focused CanActivate guard rather than extending
// ThrottlerGuard because @nestjs/throttler's per-route options cannot express
// per-role buckets cleanly; this keeps parity with the global ThrottlerModule
// config while adding role awareness.
import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RoleThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(RoleThrottlerGuard.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly jwt: JwtService;

  private readonly windowMs: number;
  private readonly limits: Record<string, number>;

  constructor(private readonly config: ConfigService) {
    // Guards registered via APP_GUARD run before controller-level
    // JwtAuthGuard has populated req.user, so we verify the bearer token
    // here ourselves (same secret as AuthModule) instead of trusting an
    // unverified claim that could escalate a client into a bigger bucket.
    this.jwt = new JwtService({ secret: config.get<string>('JWT_SECRET') });

    this.windowMs = this.config.get<number>('ROLE_THROTTLE_WINDOW_MS', 60000);
    this.limits = {
      anon: this.config.get<number>('ROLE_THROTTLE_ANON_LIMIT', 20),
      STUDENT: this.config.get<number>('ROLE_THROTTLE_STUDENT_LIMIT', 60),
      INSTRUCTOR: this.config.get<number>('ROLE_THROTTLE_INSTRUCTOR_LIMIT', 120),
      ADMIN: this.config.get<number>('ROLE_THROTTLE_ADMIN_LIMIT', 300),
    };
  }

  /** Resolves the authenticated subject, verifying the JWT when needed. */
  private resolveSubject(req: Record<string, any>): { role: string; id: string } {
    if (req.user?.role && req.user?.id) {
      return { role: req.user.role, id: req.user.id };
    }

    const authHeader: string | undefined = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verify(authHeader.slice(7)) as {
          sub?: string;
          role?: string;
        };
        if (payload?.sub) {
          return { role: payload.role ?? 'anon', id: payload.sub };
        }
      } catch {
        // Expired or malformed token → fall through to the anonymous bucket.
      }
    }
    return { role: 'anon', id: req.ip ?? 'unknown' };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Record<string, any>>();
    const res = http.getResponse<Response>();

    const subject = this.resolveSubject(req);
    const roleBucket =
      this.limits[subject.role] !== undefined ? subject.role : 'anon';
    const key = `${roleBucket}:${subject.id}`;
    const max = this.limits[roleBucket];
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
      this.pruneExpired(now);
    }
    bucket.count += 1;

    res.setHeader('X-RateLimit-Bucket', roleBucket);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', retryAfterSeconds);
      this.logger.warn(
        `Role throttle exceeded: bucket=${roleBucket} subject=${subject.id} ${bucket.count}/${max}`,
      );
      res.status(429).json({
        success: false,
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit for your account tier.',
        retryAfterSeconds,
      });
      return false;
    }

    return true;
  }

  /** Amortised eviction of idle buckets to bound memory usage. */
  private pruneExpired(now: number) {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
