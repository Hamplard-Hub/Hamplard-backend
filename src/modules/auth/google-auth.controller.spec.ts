import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { GoogleAuthController } from './google-auth.controller';

describe('GoogleAuthController', () => {
  const googleAuth = {
    login: jest.fn(),
    createAuthCode: jest.fn(),
    getFrontendCallbackUrl: jest.fn(),
    consumeAuthCode: jest.fn(),
    loginWithIdToken: jest.fn(),
    loginWithIdTokenAndTotp: jest.fn(),
  };
  const controller = new GoogleAuthController(googleAuth as any);
  const request = { headers: { 'user-agent': 'browser' }, ip: '203.0.113.12' } as Request;

  beforeEach(() => jest.clearAllMocks());

  it('starts OAuth and redirects callback sign-ins through a one-time code', async () => {
    expect(controller.start()).toBeUndefined();
    googleAuth.login.mockResolvedValue({ accessToken: 'access' });
    googleAuth.createAuthCode.mockResolvedValue('one-time-code');
    googleAuth.getFrontendCallbackUrl.mockReturnValue('https://frontend.test/callback?code=one-time-code');
    const response = { redirect: jest.fn() } as unknown as Response;

    await controller.callback({ ...request, user: { googleId: 'google-1' } } as any, response);

    expect(googleAuth.login).toHaveBeenCalledWith(
      { googleId: 'google-1' },
      { userAgent: 'browser', ipAddress: request.ip },
    );
    expect(googleAuth.createAuthCode).toHaveBeenCalledWith({ accessToken: 'access' });
    expect(response.redirect).toHaveBeenCalledWith(
      'https://frontend.test/callback?code=one-time-code',
    );
  });

  it('exchanges valid codes and rejects missing or expired codes', async () => {
    googleAuth.consumeAuthCode.mockResolvedValueOnce({ accessToken: 'access' });
    await expect(controller.exchange({ code: 'valid-code' } as any)).resolves.toEqual({
      accessToken: 'access',
    });

    googleAuth.consumeAuthCode.mockResolvedValueOnce(null);
    await expect(controller.exchange({ code: 'expired-code' } as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('uses the appropriate token login flow with or without a TOTP code', () => {
    const dto = { idToken: 'google-id-token' };
    controller.loginWithToken(dto as any, request);
    expect(googleAuth.loginWithIdToken).toHaveBeenCalledWith(dto.idToken, {
      userAgent: 'browser',
      ipAddress: request.ip,
    });

    controller.loginWithToken({ ...dto, totpCode: '123456' } as any, request);
    expect(googleAuth.loginWithIdTokenAndTotp).toHaveBeenCalledWith(
      dto.idToken,
      '123456',
      { userAgent: 'browser', ipAddress: request.ip },
    );
  });
});
