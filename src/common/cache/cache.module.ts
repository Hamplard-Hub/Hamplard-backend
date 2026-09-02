// cache.module.ts — issue #92: Redis-backed API response caching layer
import { Global, Module } from '@nestjs/common';
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { CacheService } from './cache.service';
import { HttpCacheInterceptor } from './cache.interceptor';

@Global()
@Module({
  imports: [NestCacheModule.register({ isGlobal: false })],
  providers: [CacheService, HttpCacheInterceptor],
  exports: [CacheService, HttpCacheInterceptor],
})
export class CacheModule {}
