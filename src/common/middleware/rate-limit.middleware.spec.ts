import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import {
  RateLimitMiddleware,
  normalizeApiPrefix,
} from './rate-limit.middleware';

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

describe('normalizeApiPrefix', () => {
  it('normalizes leading and trailing slashes', () => {
    expect(normalizeApiPrefix('api/v1')).toBe('/api/v1');
    expect(normalizeApiPrefix('/api/v2/')).toBe('/api/v2');
    expect(normalizeApiPrefix('internal')).toBe('/internal');
  });
});

describe('RateLimitMiddleware', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies the sensitive auth budget under a custom API_PREFIX', () => {
    const middleware = new RateLimitMiddleware(
      mockConfig({
        API_PREFIX: '/internal/v2/',
        RATE_LIMIT_SENSITIVE_MAX: 2,
        RATE_LIMIT_STANDARD_MAX: 100,
        RATE_LIMIT_WINDOW_MS: 60_000,
      }),
    );
    const res = mockRes();

    middleware.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request,
      res,
      next,
    );
    middleware.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request,
      res,
      next,
    );
    middleware.use(
      { originalUrl: '/internal/v2/auth/login', ip: '203.0.113.10' } as Request,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers['X-RateLimit-Limit']).toBe(2);
  });

  it('does not treat /api/v1/auth as sensitive when API_PREFIX is custom', () => {
    const middleware = new RateLimitMiddleware(
      mockConfig({
        API_PREFIX: 'internal/v2',
        RATE_LIMIT_SENSITIVE_MAX: 1,
        RATE_LIMIT_STANDARD_MAX: 100,
        RATE_LIMIT_WINDOW_MS: 60_000,
      }),
    );
    const res = mockRes();

    middleware.use(
      { originalUrl: '/api/v1/auth/login', ip: '198.51.100.9' } as Request,
      res,
      next,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
  });

  it('exempts health checks under the configured prefix', () => {
    const middleware = new RateLimitMiddleware(
      mockConfig({
        API_PREFIX: 'gateway',
        RATE_LIMIT_STANDARD_MAX: 1,
        RATE_LIMIT_WINDOW_MS: 60_000,
      }),
    );
    const res = mockRes();

    middleware.use(
      { originalUrl: '/gateway/health', ip: '192.0.2.10' } as Request,
      res,
      next,
    );
    middleware.use(
      { originalUrl: '/gateway/health?ready=1', ip: '192.0.2.10' } as Request,
      res,
      next,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keys buckets by req.ip so proxy-untrusted addresses stay distinct', () => {
    const middleware = new RateLimitMiddleware(
      mockConfig({
        API_PREFIX: 'api/v1',
        RATE_LIMIT_SENSITIVE_MAX: 1,
        RATE_LIMIT_WINDOW_MS: 60_000,
      }),
    );
    const res = mockRes();

    middleware.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.1' } as Request,
      res,
      next,
    );
    middleware.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.2' } as Request,
      res,
      next,
    );
    middleware.use(
      { originalUrl: '/api/v1/auth/login', ip: '203.0.113.1' } as Request,
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
