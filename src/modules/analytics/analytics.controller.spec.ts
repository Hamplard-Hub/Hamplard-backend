import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsController', () => {
  let app: INestApplication;
  const analyticsService = {
    trackEvent: jest.fn(),
    trackEventsBatch: jest.fn(),
  };

  const mockJwtGuard = {
    canActivate: jest.fn((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'auth-user', role: 'STUDENT' };
      return true;
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: analyticsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    analyticsService.trackEvent.mockResolvedValue({ id: 'evt-1' });
  });

  it('attributes ingested events to the authenticated caller, ignoring body userId', async () => {
    const response = await request(app.getHttpServer())
      .post('/analytics/events')
      .set('User-Agent', 'Mozilla/5.0 (tests)')
      .send({
        eventType: 'page_view',
        path: '/courses',
        userId: 'victim-user',
      });

    expect(response.status).toBe(400);
    expect(analyticsService.trackEvent).not.toHaveBeenCalled();
  });

  it('never lets a client-supplied userId override the authenticated identity when extra fields are stripped', async () => {
    const response = await request(app.getHttpServer())
      .post('/analytics/events')
      .set('User-Agent', 'Mozilla/5.0 (tests)')
      .send({
        eventType: 'page_view',
        path: '/courses',
      });

    expect(response.status).toBe(201);
    expect(analyticsService.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'page_view', path: '/courses' }),
      expect.objectContaining({
        userId: 'auth-user',
        userAgent: 'Mozilla/5.0 (tests)',
      }),
    );
    const meta = analyticsService.trackEvent.mock.calls[0][1];
    expect(meta.userId).not.toBe('victim-user');
  });

  it('sources user-agent from the request header, not the body', async () => {
    const response = await request(app.getHttpServer())
      .post('/analytics/events')
      .set('User-Agent', 'Header-Agent/2.0')
      .send({
        eventType: 'click',
        userAgent: 'Body-Spoofed-Agent',
      });

    expect(response.status).toBe(400);
    expect(analyticsService.trackEvent).not.toHaveBeenCalled();
  });

  it('passes a missing User-Agent header through as undefined', async () => {
    const response = await request(app.getHttpServer())
      .post('/analytics/events')
      .unset('User-Agent')
      .send({ eventType: 'search' });

    expect(response.status).toBe(201);
    expect(analyticsService.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'search' }),
      expect.objectContaining({
        userId: 'auth-user',
      }),
    );
    const meta = analyticsService.trackEvent.mock.calls[0][1];
    expect(meta.userAgent === undefined || meta.userAgent === '').toBe(true);
  });
});
