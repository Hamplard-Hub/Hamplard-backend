import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** String entries are matched exactly by the CORS middleware, never as patterns. */
export function buildCorsOptions(
  origins = 'http://localhost:3001',
): CorsOptions {
  return {
    origin: origins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-captcha-token'],
    credentials: true,
  };
}
