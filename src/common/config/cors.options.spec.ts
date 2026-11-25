import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import request = require('supertest');
import { buildCorsOptions } from './cors.options';

@Module({})
class CorsTestModule {}

async function createApp(origins?: string) {
  const app = await NestFactory.create<NestExpressApplication>(CorsTestModule, {
    logger: false,
  });
  app.enableCors(buildCorsOptions(origins));
  app.use('/probe', (_req, res) => res.status(200).json({ ok: true }));
  await app.init();
  return app;
}

describe('CORS origin allowlist', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp(
      ' https://app.example.com, ,https://admin.example.com, http://localhost:3001, ',
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    'https://app.example.com',
    'https://admin.example.com',
    'http://localhost:3001',
  ])(
    'allows configured origin %s on requests and preflights',
    async (origin) => {
      const response = await request(app.getHttpServer())
        .get('/probe')
        .set('Origin', origin)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers.vary).toContain('Origin');
      const preflight = await request(app.getHttpServer())
        .options('/probe')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Authorization,x-captcha-token')
        .expect(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(origin);
      expect(preflight.headers['access-control-allow-methods']).toContain(
        'POST',
      );
      expect(preflight.headers['access-control-allow-headers']).toContain(
        'x-captcha-token',
      );
    },
  );

  it.each([
    'https://evil.example.com',
    'https://app.example.com.evil.test',
    'http://app.example.com',
    'https://app.example.com:444',
    'https://app.example.com/',
    'null',
  ])('does not allow non-matching origin %s', async (origin) => {
    for (const method of ['get', 'options'] as const) {
      const response = await request(app.getHttpServer())
        [method]('/probe')
        .set('Origin', origin);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('keeps requests without an Origin working without granting an origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([undefined, 'http://localhost:3001'])(
    'preserves the default and single-origin configuration (%s)',
    async (origins) => {
      const single = await createApp(origins);
      try {
        await request(single.getHttpServer())
          .get('/probe')
          .set('Origin', 'http://localhost:3001')
          .expect('Access-Control-Allow-Origin', 'http://localhost:3001');
      } finally {
        await single.close();
      }
    },
  );

  it.each([' , , ', '*'])(
    'does not grant arbitrary origins for %s',
    async (origins) => {
      const restricted = await createApp(origins);
      try {
        const response = await request(restricted.getHttpServer())
          .get('/probe')
          .set('Origin', 'https://unlisted.test');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        await restricted.close();
      }
    },
  );
});
