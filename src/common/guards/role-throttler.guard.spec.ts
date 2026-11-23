/**
 * Unit tests for RoleThrottlerGuard.
 *
 * Redis is replaced with an in-memory counter mock so no network connection
 * is required. JWT verification uses a real JwtService with a test secret.
 */
import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RoleThrottlerGuard } from './role-throttler.guard';
import { RedisRateLimitService } from '../redis-rate-limit/redis-rate-limit.service';

// ---------------------------------------------------------------------------
// In-memory counter mock
// ---------------------------------------------------------------------------

class FakeRateLimitService {
  private counters = new Map<string, number>();

  async fixedWindow(key: string, windowSeconds: number) {
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return { count, ttlSeconds: windowSeconds };
  }

  reset() { this.counters.clear(); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret';

function buildGuard(
  limits: Record<string, number> = {},
  fakeRl?: FakeRateLimitService,
): [RoleThrottlerGuard, FakeRateLimitService] {
  const rl = fakeRl ?? new FakeRateLimitService();
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const cfg: Record<string, unknown> = {
        JWT_SECRET:                   TEST_SECRET,
        ROLE_THROTTLE_WINDOW_MS:      60_000,
        ROLE_THROTTLE_ANON_LIMIT:     limits.anon       ?? 2,
        ROLE_THROTTLE_STUDENT_LIMIT:  limits.STUDENT    ?? 10,
        ROLE_THROTTLE_INSTRUCTOR_LIMIT: limits.INSTRUCTOR ?? 20,
        ROLE_THROTTLE_ADMIN_LIMIT:    limits.ADMIN      ?? 50,
      };
      return cfg[key] !== undefined ? cfg[key] : fallback;
    }),
  } as unknown as ConfigService;

  const guard = new RoleThrottlerGuard(config, rl as unknown as RedisRateLimitService);
  return [guard, rl];
}

function makeContext(
  req: Partial<Record<string, any>>,
): ExecutionContext {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '127.0.0.1', ...req }),
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function makeJwt(payload: Record<string, unknown>) {
  const jwt = new JwtService({ secret: TEST_SECRET });
  return jwt.sign(payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoleThrottlerGuard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows a request within the anon limit', async () => {
    const [guard] = buildGuard({ anon: 5 });
    const ctx = makeContext({ ip: '10.0.0.1' });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('blocks a request that exceeds the anon limit', async () => {
    // Limit 1 anon request per window.
    const [guard, rl] = buildGuard({ anon: 1 });

    // First request is fine.
    await guard.canActivate(makeContext({ ip: '10.0.0.2' }));
    // Second request exceeds the limit.
    const result = await guard.canActivate(makeContext({ ip: '10.0.0.2' }));
    expect(result).toBe(false);
  });

  it('places authenticated requests into the correct role bucket', async () => {
    const [guard] = buildGuard({ STUDENT: 5, anon: 1 });
    const token = makeJwt({ sub: 'student-99', role: 'STUDENT' });

    // With a valid JWT, should be placed in the STUDENT bucket (limit 5)
    // rather than anon (limit 1) so the first 2 requests succeed.
    const ctx1 = makeContext({ headers: { authorization: `Bearer ${token}` } });
    const ctx2 = makeContext({ headers: { authorization: `Bearer ${token}` } });
    expect(await guard.canActivate(ctx1)).toBe(true);
    expect(await guard.canActivate(ctx2)).toBe(true);
  });

  it('falls back to anon bucket for an expired/malformed JWT', async () => {
    const [guard] = buildGuard({ anon: 1 });
    const ctx = makeContext({ headers: { authorization: 'Bearer not.a.jwt' } });
    // First request is allowed.
    expect(await guard.canActivate(ctx)).toBe(true);
    // Second request is blocked (anon limit = 1).
    expect(await guard.canActivate(ctx)).toBe(false);
  });

  it('uses req.user when already populated (skips JWT decode)', async () => {
    const [guard] = buildGuard({ ADMIN: 5, anon: 1 });
    // Simulate a request where JwtAuthGuard already ran.
    const ctx = makeContext({ user: { id: 'admin-1', role: 'ADMIN' } });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('fails open when Redis throws', async () => {
    const brokenRl = {
      fixedWindow: jest.fn().mockRejectedValue(new Error('Redis down')),
    } as unknown as RedisRateLimitService;

    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const m: Record<string, unknown> = {
          JWT_SECRET: TEST_SECRET,
          ROLE_THROTTLE_WINDOW_MS: 60_000,
          ROLE_THROTTLE_ANON_LIMIT: 5,
          ROLE_THROTTLE_STUDENT_LIMIT: 10,
          ROLE_THROTTLE_INSTRUCTOR_LIMIT: 20,
          ROLE_THROTTLE_ADMIN_LIMIT: 50,
        };
        return m[key] !== undefined ? m[key] : fallback;
      }),
    } as unknown as ConfigService;

    const guard = new RoleThrottlerGuard(config, brokenRl);
    expect(await guard.canActivate(makeContext({}))).toBe(true);
  });
});
