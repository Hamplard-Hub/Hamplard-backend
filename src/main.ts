import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { initializeSentry } from './common/logging/sentry';
import { buildSwaggerConfig } from './swagger.config';
import { parseTrustProxy } from './common/config/env.util';

async function bootstrap() {
  initializeSentry();
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    // rawBody: true makes the unparsed request body available as req.rawBody
    // (Buffer), which WebhookSignatureMiddleware needs for HMAC-SHA256 signing.
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const port       = config.get<number>('PORT', 3000);
  const apiPrefix  = config.get<string>('API_PREFIX', 'api/v1');
  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:3001');
  const trustProxy = parseTrustProxy(config.get<unknown>('TRUST_PROXY'));

  // `req.ip` (used by RateLimitMiddleware) follows this setting.
  // Default false: do not trust X-Forwarded-For. See .env.example TRUST_PROXY.
  app.set('trust proxy', trustProxy);
  if (trustProxy !== false) {
    logger.log(`Express trust proxy enabled: ${JSON.stringify(trustProxy)}`);
  }

  app.use(helmet());

  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-captcha-token'],
    credentials: true,
  });

  app.setGlobalPrefix(apiPrefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const swaggerConfig = buildSwaggerConfig();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port);
  logger.log(`Hamplard API running on http://localhost:${port}/${apiPrefix}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
