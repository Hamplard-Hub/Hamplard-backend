import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const port       = config.get<number>('PORT', 3000);
  const apiPrefix  = config.get<string>('API_PREFIX', 'api/v1');
  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:3001');

  app.use(helmet());

  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Hamplard API')
    .setDescription(
      'Backend API for Hamplard — Africa\'s practical skills online learning platform',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth',         'Stellar wallet authentication')
    .addTag('users',        'User profiles and management')
    .addTag('courses',      'Course creation, approval, and browsing')
    .addTag('lessons',      'Lesson content and progress')
    .addTag('enrollments',  'Course enrollment and payments')
    .addTag('assignments',  'Practical assignment submission and review')
    .addTag('certificates', 'Certificate issuance and verification')
    .addTag('events',       'On-chain Stellar event feed')
    .addTag('notifications','User notifications')
    .addTag('health',       'Health check')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port);
  logger.log(`Hamplard API running on http://localhost:${port}/${apiPrefix}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
