import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { Reflector } from '@nestjs/core';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { FeatureFlagGuard } from '../feature-flags/feature-flag.guard';

describe('GoogleAuthController feature gate', () => {
  let app: INestApplication;
  const featureFlags = { isEnabled: jest.fn() };
  const googleAuth = {
    loginWithIdToken: jest.fn().mockResolvedValue({ accessToken: 'token' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GoogleAuthController],
      providers: [
        Reflector,
        FeatureFlagGuard,
        { provide: FeatureFlagsService, useValue: featureFlags },
        { provide: GoogleAuthService, useValue: googleAuth },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 404 without invoking Google login when the feature flag is disabled', async () => {
    featureFlags.isEnabled.mockResolvedValue(false);

    const response = await request(app.getHttpServer())
      .post('/auth/google/token')
      .send({ idToken: 'google-id-token' });

    expect(response.status).toBe(404);
    expect(googleAuth.loginWithIdToken).not.toHaveBeenCalled();
  });

  it('allows the endpoint when Google login is enabled', async () => {
    featureFlags.isEnabled.mockResolvedValue(true);

    const response = await request(app.getHttpServer())
      .post('/auth/google/token')
      .send({ idToken: 'google-id-token' });

    expect(response.status).toBe(201);
    expect(googleAuth.loginWithIdToken).toHaveBeenCalledWith(
      'google-id-token',
      expect.any(Object),
    );
  });
});
