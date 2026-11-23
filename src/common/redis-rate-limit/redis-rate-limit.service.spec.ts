/**
 * Unit tests for RedisRateLimitService.
 *
 * The ioredis client is replaced with a lightweight in-memory mock so no
 * real Redis connection is required.
 */
import { ConfigService } from '@nestjs/config';
import { RedisRateLimitService } from './redis-rate-limit.service';

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock
// ---------------------------------------------------------------------------

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  }

  private live(key: string): { value: string; expiresAt?: number } | undefined {
    if (this.isExpired(key)) {
      this.store.delete(key);
      return undefined;
    }
    return this.store.get(key);
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    const current = entry ? parseInt(entry.value, 10) : 0;
    const next = current + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2; // key does not exist
    if (entry.expiresAt === undefined) return -1; // no expiry
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  pipeline() {
    // Collect commands and run them synchronously when exec() is called.
    const commands: Array<() => Promise<[null, unknown]>> = [];
    const self = this;
    return {
      incr(key: string) {
        commands.push(async () => [null, await self.incr(key)]);
        return this;
      },
      ttl(key: string) {
        commands.push(async () => [null, await self.ttl(key)]);
        return this;
      },
      async exec(): Promise<Array<[null, unknown]>> {
        const results: Array<[null, unknown]> = [];
        for (const cmd of commands) {
          results.push(await cmd());
        }
        return results;
      },
    };
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK'> {
    let expiresAt: number | undefined;
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1] * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  on() { return this; }
  async quit() { return 'OK'; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildService(configValues: Record<string, unknown> = {}) {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in configValues ? configValues[key] : fallback,
    ),
  } as unknown as ConfigService;

  const svc = new RedisRateLimitService(config);
  // Inject fake Redis instead of opening a real connection.
  (svc as any).redis = new FakeRedis();
  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisRateLimitService.fixedWindow', () => {
  it('increments the counter on each call', async () => {
    const svc = buildService();
    const r1 = await svc.fixedWindow('test:key', 60);
    const r2 = await svc.fixedWindow('test:key', 60);
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
  });

  it('sets TTL on first increment and returns windowSeconds as ttlSeconds', async () => {
    const svc = buildService();
    const { count, ttlSeconds } = await svc.fixedWindow('fresh:key', 30);
    expect(count).toBe(1);
    // On first call the key had no expiry (TTL = -1) so we set it to windowSeconds.
    expect(ttlSeconds).toBe(30);
  });

  it('does not reset the window for subsequent requests in the same window', async () => {
    const svc = buildService();
    await svc.fixedWindow('rolling:key', 60); // first — sets TTL
    const { count } = await svc.fixedWindow('rolling:key', 60); // second
    // Count should be 2, not 1 (window was not reset).
    expect(count).toBe(2);
  });

  it('uses separate counters for separate keys', async () => {
    const svc = buildService();
    await svc.fixedWindow('key:a', 60);
    await svc.fixedWindow('key:a', 60);
    const { count } = await svc.fixedWindow('key:b', 60);
    expect(count).toBe(1);
  });
});

describe('RedisRateLimitService.getJson / setJson / del', () => {
  it('round-trips a JSON object', async () => {
    const svc = buildService();
    await svc.setJson('obj:1', { x: 42 }, 60);
    const result = await svc.getJson<{ x: number }>('obj:1');
    expect(result).toEqual({ x: 42 });
  });

  it('returns null for a missing key', async () => {
    const svc = buildService();
    expect(await svc.getJson('missing')).toBeNull();
  });

  it('del removes the key', async () => {
    const svc = buildService();
    await svc.setJson('del:me', { v: 1 }, 60);
    await svc.del('del:me');
    expect(await svc.getJson('del:me')).toBeNull();
  });
});
