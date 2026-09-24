import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { ThrottlerModule } from '@nestjs/throttler';

describe('AuthController Throttling (Integration)', () => {
  let app: INestApplication;

  const authService = {
    generateNonce: jest.fn().mockReturnValue('mock-nonce'),
    login: jest.fn().mockResolvedValue({ accessToken: 'access-jwt', refreshToken: 'refresh-jwt' }),
  };

  const captchaService = {
    verifyBeforeNonce: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          {
            name: 'default',
            ttl: 60000,
            limit: 10,
          },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: CaptchaService, useValue: captchaService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests within limit on /auth/nonce and returns 429 when limit is exceeded', async () => {
    // Send requests up to limit
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer())
        .get('/auth/nonce')
        .query({ address: 'GABC123', captchaToken: 'valid-token' });
      expect(res.status).toBe(200);
    }

    // 11th request should be rate-limited with HTTP 429
    const limitedRes = await request(app.getHttpServer())
      .get('/auth/nonce')
      .query({ address: 'GABC123', captchaToken: 'valid-token' });

    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers['retry-after']).toBeDefined();
  });
});
