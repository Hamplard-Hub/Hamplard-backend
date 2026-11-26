// role-throttler.guard.ts
// Issue #72 — differentiated throttling policy per authenticated role.
// Issue #433 — the bucket role comes from the same cached user lookup as
// JwtStrategy, never from a (possibly stale) role claim in the access token.
//
// Buckets: anon:<ip> (strictest), STUDENT:<id>, INSTRUCTOR:<id>, ADMIN:<id>.
// Limits are env-tunable per bucket; every response carries X-RateLimit-*
// status headers and a rejected request gets 429 + Retry-After.
//
// Counters are stored in Redis (INCR + EXPIRE fixed-window) so limits are
// shared across instances and survive process restarts.
//
// Note: implemented as a focused CanActivate guard rather than extending
// ThrottlerGuard because @nestjs/throttler's per-route options cannot express
// per-role buckets cleanly; this keeps parity with the global ThrottlerModule
// config while adding role awareness.
import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { RedisRateLimitService } from '../redis-rate-limit/redis-rate-limit.service';
import { AuthUserCacheService } from '../auth-user/auth-user-cache.service';

@Injectable()
export class RoleThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(RoleThrottlerGuard.name);
  private readonly jwt: JwtService;

  private readonly windowMs: number;
  private readonly windowSeconds: number;
  private readonly limits: Record<string, number>;

  constructor(
    private readonly config: ConfigService,
    private readonly rl: RedisRateLimitService,
    private readonly users: AuthUserCacheService,
  ) {
    // Guards registered via APP_GUARD run before controller-level
    // JwtAuthGuard has populated req.user, so we verify the bearer token here
    // ourselves. Only `sub` is used: the role is resolved from the shared
    // cached user record, so demoted/banned users lose their larger bucket.
    this.jwt = new JwtService({ secret: config.get<string>('JWT_SECRET') });

    this.windowMs      = this.config.get<number>('ROLE_THROTTLE_WINDOW_MS', 60_000);
    this.windowSeconds = Math.ceil(this.windowMs / 1000);
    this.limits = {
      anon:       this.config.get<number>('ROLE_THROTTLE_ANON_LIMIT',       20),
      STUDENT:    this.config.get<number>('ROLE_THROTTLE_STUDENT_LIMIT',    60),
      INSTRUCTOR: this.config.get<number>('ROLE_THROTTLE_INSTRUCTOR_LIMIT', 120),
      ADMIN:      this.config.get<number>('ROLE_THROTTLE_ADMIN_LIMIT',      300),
    };
  }

  /** Resolves the authenticated subject and its live role from the user cache. */
  private async resolveSubject(req: Record<string, any>): Promise<{ role: string; id: string }> {
    if (req.user?.id) {
      // JwtAuthGuard already ran: req.user was built by JwtStrategy from the
      // same cached lookup, so its role is authoritative.
      if (req.user.isBanned || req.user.isDeactivated) {
        return { role: 'anon', id: req.ip ?? 'unknown' };
      }
      return { role: req.user.role ?? 'anon', id: req.user.id };
    }

    const authHeader: string | undefined = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verify(authHeader.slice(7)) as {
          sub?: string;
          typ?: string;
        };
        if (payload?.sub && payload.typ !== 'refresh') {
          const user = await this.users.getUser(payload.sub);
          if (user) {
            this.users.assertActive(user);
            return { role: user.role, id: user.id };
          }
        }
      } catch {
        // Expired/malformed token or unavailable user → anonymous bucket.
      }
    }
    return { role: 'anon', id: req.ip ?? 'unknown' };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req  = http.getRequest<Record<string, any>>();
    const res  = http.getResponse<Response>();

    const subject    = await this.resolveSubject(req);
    const roleBucket = this.limits[subject.role] !== undefined ? subject.role : 'anon';
    const max        = this.limits[roleBucket];
    const key        = `rl:role:${roleBucket}:${subject.id}`;

    let count: number;
    let ttlSeconds: number;

    try {
      ({ count, ttlSeconds } = await this.rl.fixedWindow(key, this.windowSeconds));
    } catch (err) {
      // Redis unavailable — fail open to avoid blocking legitimate traffic.
      this.logger.error(`Role-throttle Redis error (fail-open): ${(err as Error).message}`);
      return true;
    }

    const resetEpoch = Math.ceil(Date.now() / 1000) + ttlSeconds;

    res.setHeader('X-RateLimit-Bucket',    roleBucket);
    res.setHeader('X-RateLimit-Limit',     max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    res.setHeader('X-RateLimit-Reset',     String(resetEpoch));

    if (count > max) {
      res.setHeader('Retry-After', ttlSeconds);
      this.logger.warn(
        `Role throttle exceeded: bucket=${roleBucket} subject=${subject.id} ${count}/${max}`,
      );
      res.status(429).json({
        success: false,
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit for your account tier.',
        retryAfterSeconds: ttlSeconds,
      });
      return false;
    }

    return true;
  }
}
