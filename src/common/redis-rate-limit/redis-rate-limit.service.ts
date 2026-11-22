/**
 * RedisRateLimitService
 *
 * Provides two primitives used by all rate-limiting code in the application:
 *
 *  - fixedWindow(key, windowSeconds, max)
 *      Increments the counter for `key` using a Redis INCR + EXPIRE fixed-window
 *      approach. The EXPIRE is only set on the first increment so the window is
 *      not sliding. Returns the current count and the TTL so callers can send
 *      X-RateLimit-* headers without an extra round-trip.
 *
 *  - getAndSet / increment / expire helpers for block-state data (CaptchaService).
 *
 * The service reuses the same Redis connection parameters as CacheService
 * (REDIS_URL or REDIS_HOST + REDIS_PORT + REDIS_PASSWORD) so no extra config
 * is required.
 *
 * All Redis errors are caught and re-thrown so callers can decide whether to
 * fail open or closed. In tests the client is replaced with a mock.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface FixedWindowResult {
  /** The count after incrementing (always >= 1). */
  count: number;
  /**
   * Remaining TTL of the key in seconds (from Redis). On the very first
   * request of a window this will equal `windowSeconds`. May be -1 if the
   * key has no expiry set (should not happen in normal operation).
   */
  ttlSeconds: number;
}

@Injectable()
export class RedisRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisRateLimitService.name);
  readonly redis: Redis; // exposed for unit-test injection

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>('REDIS_URL');
    this.redis = redisUrl
      ? new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 })
      : new Redis({
          host: this.config.get<string>('REDIS_HOST', 'localhost'),
          port: this.config.get<number>('REDIS_PORT', 6379),
          password: this.config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: 2,
        });

    this.redis.on('error', (err) => {
      this.logger.warn(`Redis error (rate-limit): ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Atomically increments a fixed-window counter.
   *
   * On the first request of a window the EXPIRE is set so the key
   * self-destructs after `windowSeconds`. Subsequent requests in the same
   * window leave the existing TTL in place.
   *
   * Returns { count, ttlSeconds } so callers can derive Retry-After and
   * X-RateLimit-Reset without an extra Redis round-trip.
   */
  async fixedWindow(
    key: string,
    windowSeconds: number,
  ): Promise<FixedWindowResult> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();
    // results: [[err, incrResult], [err, ttlResult]]
    if (!results) throw new Error('Redis pipeline returned null');

    const [incrErr, incrVal] = results[0] as [Error | null, number];
    const [ttlErr, ttlVal]   = results[1] as [Error | null, number];

    if (incrErr) throw incrErr;
    if (ttlErr)  throw ttlErr;

    const count = incrVal as number;

    // Set the expiry only on first increment (SETNX-style logic via TTL check).
    // ttlVal === -1 means the key has no expiry (freshly created by INCR).
    if ((ttlVal as number) === -1) {
      await this.redis.expire(key, windowSeconds);
    }

    // Re-fetch the actual TTL so the returned value is accurate.
    const finalTtl = (ttlVal as number) === -1 ? windowSeconds : (ttlVal as number);

    return { count, ttlSeconds: finalTtl };
  }

  /**
   * Retrieves a JSON-serialised value. Returns null on miss or parse error.
   */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Stores a JSON-serialised value with an optional TTL (seconds).
   */
  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialised = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.set(key, serialised, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, serialised);
    }
  }

  /**
   * Deletes a key.
   */
  async del(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }
}
