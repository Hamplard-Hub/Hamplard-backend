import { Global, Module } from '@nestjs/common';
import { RedisRateLimitService } from './redis-rate-limit.service';

/**
 * Global module so RateLimitMiddleware, RoleThrottlerGuard,
 * CaptchaService and OtpService can all inject RedisRateLimitService
 * without importing this module in every feature module.
 */
@Global()
@Module({
  providers: [RedisRateLimitService],
  exports: [RedisRateLimitService],
})
export class RedisRateLimitModule {}
