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
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import {
  RateLimitMiddleware,
  normalizeApiPrefix,
} from './rate-limit.middleware';
import { RedisRateLimitService } from '../redis-rate-limit/redis-rate-limit.service';

// ---------------------------------------------------------------------------
// In-memory RedisRateLimitService mock (no real Redis connection)
// ---------------------------------------------------------------------------

class FakeRateLimitService {
  private counters = new Map<string, number>();

  async fixedWindow(key: string, _windowSeconds: number) {
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return { count, ttlSeconds: _windowSeconds };
  }

  reset() { this.counters.clear(); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      values[key] !== undefined ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
}

function mockRes() {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    setHeader: jest.fn((name: string, value: unknown) => {
      headers[name] = value;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response & { headers: Record<string, unknown> };
}

function buildMiddleware(
  configValues: Record<string, unknown>,
  fakeRl?: FakeRateLimitService,
): [RateLimitMiddleware, FakeRateLimitService] {
  const rl = fakeRl ?? new FakeRateLimitService();
  const mw = new RateLimitMiddleware(
    mockConfig(configValues),
    rl as unknown as RedisRateLimitService,
  );
  return [mw, rl];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeApiPrefix', () => {
  it('normalizes leading and trailing slashes', () => {
    expect(normalizeApiPrefix('api/v1')).toBe('/api/v1');
    expect(normalizeApiPrefix('/api/v2/')).toBe('/api/v2');
    expect(normalizeApiPrefix('internal')).toBe('/internal');
  });
});

describe('RateLimitMiddleware', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => jest.clearAllMocks());

  it('applies the sensitive auth budget under a custom API_PREFIX', async () => {
    const [mw] = buildMiddleware({
      API_PREFIX: '/internal/v2/',
      RATE_LIMIT_SENSITIVE_MAX: 2,
      RATE_LIMIT_STANDARD_MAX: 100,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });
    const res = mockRes();

    // 3 requests against limit of 2: third should be rejected
    await mw.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request, res, next,
    );
    await mw.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request, res, next,
    );
    await mw.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request, res, next,
    );

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers['X-RateLimit-Limit']).toBe(2);
  });

  it('does not treat /api/v1/auth as sensitive when API_PREFIX is custom', async () => {
    const [mw] = buildMiddleware({
      API_PREFIX: 'internal/v2',
      RATE_LIMIT_SENSITIVE_MAX: 1,
      RATE_LIMIT_STANDARD_MAX: 100,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });
    const res = mockRes();

    await mw.use(
      { originalUrl: '/api/v1/auth/login', ip: '198.51.100.9' } as Request, res, next,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
  });

  it('exempts health checks under the configured prefix', async () => {
    const [mw] = buildMiddleware({
      API_PREFIX: 'gateway',
      RATE_LIMIT_STANDARD_MAX: 1,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });
    const res = mockRes();

    await mw.use(
      { originalUrl: '/gateway/health', ip: '192.0.2.10' } as Request, res, next,
    );
    await mw.use(
      { originalUrl: '/gateway/health?ready=1', ip: '192.0.2.10' } as Request, res, next,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keys buckets by req.ip so distinct addresses stay distinct', async () => {
    // Both IPs share the same FakeRateLimitService but have different Redis keys.
    const [mw] = buildMiddleware({
      API_PREFIX: 'api/v1',
      RATE_LIMIT_SENSITIVE_MAX: 1,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });
    const res = mockRes();

    await mw.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.1' } as Request, res, next,
    );
    await mw.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.2' } as Request, res, next,
    );
    // Second request from .1 should be rejected (count = 2 > limit 1).
    await mw.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.1' } as Request, res, next,
    );

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('fails open when Redis throws', async () => {
    const brokenRl = {
      fixedWindow: jest.fn().mockRejectedValue(new Error('Redis down')),
    } as unknown as RedisRateLimitService;

    const mw = new RateLimitMiddleware(
      mockConfig({ API_PREFIX: 'api/v1', RATE_LIMIT_STANDARD_MAX: 1 }),
      brokenRl,
    );
    const res = mockRes();
    // Should not throw and should call next even though Redis is down.
    await mw.use({ originalUrl: '/api/v1/users', ip: '1.2.3.4' } as Request, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
