import { Test } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as request from 'supertest';
import { LoggerModule } from './logger.module';

@Controller('test-logging')
class TestLoggingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe('LoggerModule', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        LoggerModule,
      ],
      controllers: [TestLoggingController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets x-correlation-id header on responses', async () => {
    const res = await request(app.getHttpServer()).get('/test-logging').expect(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('preserves incoming x-correlation-id header on responses', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-logging')
      .set('x-correlation-id', 'corr-12345')
      .expect(200);
    expect(res.headers['x-correlation-id']).toBe('corr-12345');
  });
});
