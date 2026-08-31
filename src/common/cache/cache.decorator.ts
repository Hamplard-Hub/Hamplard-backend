// cache.decorator.ts — issue #92: marks a GET route handler as cache-eligible
import { SetMetadata } from '@nestjs/common';

export const CACHE_NAMESPACE_KEY = 'cache:namespace';
export const CACHE_TTL_KEY = 'cache:ttl';

/** Marks a route as eligible for response caching under the given namespace. */
export const Cacheable = (namespace: string, ttlSeconds?: number) =>
  (target: any, key?: string, descriptor?: any) => {
    SetMetadata(CACHE_NAMESPACE_KEY, namespace)(target, key, descriptor);
    if (ttlSeconds !== undefined) {
      SetMetadata(CACHE_TTL_KEY, ttlSeconds)(target, key, descriptor);
    }
    return descriptor;
  };
