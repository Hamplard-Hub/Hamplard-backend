// rate-limit.middleware.ts
// Issue #71 — global request rate limiting (per-IP fixed window),
// with stricter budgets for sensitive routes and an exemption list
// for trusted services (e.g. health probes, internal callers).
//
// Counters are stored in Redis (INCR + EXPIRE) so limits are shared across
// instances and survive process restarts.
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { RedisRateLimitService } from '../redis-rate-limit/redis-rate-limit.service';

/** Strip leading/trailing slashes so API_PREFIX variants match request paths. */
export function normalizeApiPrefix(raw?: string): string {
  const trimmed = (raw ?? 'api/v1').replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);

  private readonly windowMs: number;
  private readonly windowSeconds: number;
  private readonly standardMax: number;
  private readonly sensitiveMax: number;
  private readonly exemptIps: Set<string>;
  private readonly sensitivePrefixes: string[];
  private readonly exemptPrefixes: string[];

  constructor(
    private readonly config: ConfigService,
    private readonly rl: RedisRateLimitService,
  ) {
    this.windowMs = this.config.get<number>('RATE_LIMIT_WINDOW_MS', 60_000);
    this.windowSeconds = Math.ceil(this.windowMs / 1000);
    this.standardMax  = this.config.get<number>('RATE_LIMIT_STANDARD_MAX', 100);
    this.sensitiveMax = this.config.get<number>('RATE_LIMIT_SENSITIVE_MAX', 10);

    const apiPrefix = normalizeApiPrefix(
      this.config.get<string>('API_PREFIX', 'api/v1'),
    );
    this.sensitivePrefixes = [`${apiPrefix}/auth`];
    this.exemptPrefixes    = [`${apiPrefix}/health`, '/docs', '/docs-json'];

    const exemptList =
      this.config.get<string>('RATE_LIMIT_EXEMPT_IPS', '') ?? '';
    this.exemptIps = new Set(
      exemptList.split(',').map((ip) => ip.trim()).filter(Boolean),
    );
    if (this.exemptIps.size > 0) {
      this.logger.log(`Rate-limit exemption list loaded (${this.exemptIps.size} IPs)`);
    }
  }

  async use(req: Request, res: Response, next: NextFunction) {
    const path = req.originalUrl.split('?')[0];

    if (
      this.exemptPrefixes.some((p) => path.startsWith(p)) ||
      this.exemptIps.has(req.ip ?? '')
    ) {
      return next();
    }

    const sensitive = this.sensitivePrefixes.some((p) => path.startsWith(p));
    const max = sensitive ? this.sensitiveMax : this.standardMax;
    const bucket = sensitive ? 'sensitive' : 'standard';

    const key = `rl:ip:${req.ip}:${bucket}`;

    let count: number;
    let ttlSeconds: number;

    try {
      ({ count, ttlSeconds } = await this.rl.fixedWindow(key, this.windowSeconds));
    } catch (err) {
      // Redis unavailable — fail open to avoid blocking legitimate traffic.
      this.logger.error(`Rate-limit Redis error (fail-open): ${(err as Error).message}`);
      return next();
    }

    const remaining = Math.max(0, max - count);
    const resetEpoch = Math.ceil(Date.now() / 1000) + ttlSeconds;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', String(resetEpoch));

    if (count > max) {
      res.setHeader('Retry-After', ttlSeconds);
      this.logger.warn(
        `Rate limit exceeded: ip=${req.ip} path=${path} ${count}/${max} in window`,
      );
      return res.status(429).json({
        success: false,
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'You have exceeded the request rate limit. Please slow down.',
        retryAfterSeconds: ttlSeconds,
      });
    }

    next();
  }
}
