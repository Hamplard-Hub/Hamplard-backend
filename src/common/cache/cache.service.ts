// cache.service.ts — issue #92: Redis-backed API response caching
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const DEFAULT_TTL_SECONDS = 60;

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly defaultTtlSeconds: number;

  private hits = 0;
  private misses = 0;

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
      this.logger.warn(`Redis connection error: ${err.message}`);
    });

    this.defaultTtlSeconds = this.config.get<number>('CACHE_TTL_SECONDS', DEFAULT_TTL_SECONDS);
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Deterministic cache key from a namespace and a set of query params.
   * Params are sorted so equivalent queries in a different order share a key.
   */
  buildKey(namespace: string, params: Record<string, unknown> = {}): string {
    const sortedEntries = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map((k) => `${k}=${String(params[k])}`);
    return `cache:${namespace}${sortedEntries.length ? ':' + sortedEntries.join('&') : ''}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`Cache read failed for "${key}": ${(err as Error).message}`);
      this.misses += 1;
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number = this.defaultTtlSeconds): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Cache write failed for "${key}": ${(err as Error).message}`);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }

  /** Invalidates every cached entry under a namespace, e.g. on content updates. */
  async invalidateNamespace(namespace: string): Promise<void> {
    const pattern = `cache:${namespace}*`;
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(`Cache invalidation failed for namespace "${namespace}": ${(err as Error).message}`);
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}
