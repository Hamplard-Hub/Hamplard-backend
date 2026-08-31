// cache.interceptor.ts — issue #92: read/write caching + X-Cache-Status header
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CacheService } from './cache.service';
import { CACHE_NAMESPACE_KEY, CACHE_TTL_KEY } from './cache.decorator';

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const namespace = this.reflector.getAllAndOverride<string>(CACHE_NAMESPACE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    if (!namespace || request.method !== 'GET') {
      return next.handle();
    }

    const ttl = this.reflector.getAllAndOverride<number>(CACHE_TTL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const key = this.cache.buildKey(namespace, { ...request.params, ...request.query });
    const cached = await this.cache.get(key);

    if (cached !== null) {
      response.setHeader('X-Cache-Status', 'HIT');
      return of(cached);
    }

    response.setHeader('X-Cache-Status', 'MISS');
    return next.handle().pipe(
      tap((data) => {
        void this.cache.set(key, data, ttl);
      }),
    );
  }
}
