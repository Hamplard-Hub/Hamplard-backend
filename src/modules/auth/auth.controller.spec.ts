import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { PrismaService } from '../../common/prisma/prisma.service';

import { ThrottlerModule } from '@nestjs/throttler';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    generateNonce: jest.fn().mockReturnValue('issued-nonce'),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    logoutAll: jest.fn(),
    verifySignature: jest.fn(),
  };
  const captchaService = {
    verifyBeforeNonce: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    adminAuditLog: { create: jest.fn() },
  };

  const request = { ip: '203.0.113.10', socket: { remoteAddress: '203.0.113.10' } } as Request;

  beforeEach(async () => {
    jest.clearAllMocks();
    captchaService.verifyBeforeNonce.mockResolvedValue(undefined);
    authService.generateNonce.mockReturnValue('issued-nonce');

    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: CaptchaService, useValue: captchaService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = module.get(AuthController);
  });

  it('issues a nonce only after CAPTCHA verification succeeds', async () => {
    const result = await controller.getNonce('GABCDEF', 'captcha-token', request);

    expect(captchaService.verifyBeforeNonce).toHaveBeenCalledWith(
      'captcha-token',
      '203.0.113.10',
    );
    expect(authService.generateNonce).toHaveBeenCalledWith('GABCDEF');
    expect(result).toEqual({ nonce: 'issued-nonce', address: 'GABCDEF' });
  });

  it('accepts a CAPTCHA token from the x-captcha-token header', async () => {
    await controller.getNonce('GABCDEF', undefined, request, 'header-token');

    expect(captchaService.verifyBeforeNonce).toHaveBeenCalledWith(
      'header-token',
      '203.0.113.10',
    );
    expect(authService.generateNonce).toHaveBeenCalled();
  });

  it('does not issue a nonce when CAPTCHA verification fails', async () => {
    captchaService.verifyBeforeNonce.mockRejectedValue(
      new UnauthorizedException('CAPTCHA verification failed'),
    );

    await expect(controller.getNonce('GABCDEF', 'bad-token', request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authService.generateNonce).not.toHaveBeenCalled();
  });

  it('does not issue a nonce when the IP is temporarily blocked', async () => {
    captchaService.verifyBeforeNonce.mockRejectedValue(
      new HttpException(
        'Too many failed CAPTCHA attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );

    await expect(controller.getNonce('GABCDEF', 'token', request)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(authService.generateNonce).not.toHaveBeenCalled();
  });

  it('does not issue a nonce when the CAPTCHA provider fails', async () => {
    captchaService.verifyBeforeNonce.mockRejectedValue(
      new ServiceUnavailableException('CAPTCHA verification is unavailable'),
    );

    await expect(controller.getNonce('GABCDEF', 'token', request)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(authService.generateNonce).not.toHaveBeenCalled();
  });

  it('does not trust a client-provided captchaSuccess flag', async () => {
    captchaService.verifyBeforeNonce.mockRejectedValue(
      new UnauthorizedException('CAPTCHA verification failed'),
    );

    await expect(
      controller.getNonce('GABCDEF', 'forged-token', request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.generateNonce).not.toHaveBeenCalled();
    expect(captchaService.verifyBeforeNonce).toHaveBeenCalledWith(
      'forged-token',
      '203.0.113.10',
    );
  });

  it('forwards login, refresh, and logout requests', async () => {
    const dto = { stellarAddress: 'GABC', signedNonce: 'nonce', signature: 'sig' };
    const req = { headers: { 'user-agent': 'browser' }, ip: '203.0.113.11' } as Request;
    authService.login.mockResolvedValue({ accessToken: 'access' });
    authService.refresh.mockResolvedValue({ accessToken: 'refreshed' });

    await expect(controller.login(dto as any, req)).resolves.toEqual({ accessToken: 'access' });
    expect(authService.login).toHaveBeenCalledWith(dto, { userAgent: 'browser', ipAddress: req.ip });
    await expect(controller.refresh({ refreshToken: 'refresh' } as any)).resolves.toEqual({
      accessToken: 'refreshed',
    });
    expect(authService.refresh).toHaveBeenCalledWith('refresh');
    controller.logout('user-1', 'jti-1');
    controller.logoutAll('user-1');
    expect(authService.logout).toHaveBeenCalledWith('user-1', 'jti-1');
    expect(authService.logoutAll).toHaveBeenCalledWith('user-1');
  });

  it('issues wallet-link nonces only for Google accounts and unclaimed wallets', async () => {
    await expect(
      controller.getLinkNonce({ id: 'user-1', googleId: null } as any, { stellarAddress: 'GABC' } as any, request),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.user.findUnique.mockResolvedValueOnce({ id: 'other-user' });
    await expect(
      controller.getLinkNonce({ id: 'user-1', googleId: 'google-1' } as any, { stellarAddress: 'GABC' } as any, request),
    ).rejects.toThrow('This wallet is already linked to another account');

    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      controller.getLinkNonce({ id: 'user-1', googleId: 'google-1' } as any, { stellarAddress: 'GABC' } as any, request),
    ).resolves.toEqual({ nonce: 'issued-nonce', stellarAddress: 'GABC' });
  });

  it('links a verified wallet and records the audit event', async () => {
    const user = { id: 'user-1', googleId: 'google-1' };
    const dto = { stellarAddress: 'GABC', nonce: 'nonce', signature: 'sig' };
    authService.verifySignature.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({});
    prisma.adminAuditLog.create.mockResolvedValue({});

    await expect(controller.linkWallet(user as any, dto as any, request)).resolves.toEqual({
      success: true,
      stellarAddress: 'GABC',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { stellarAddress: 'GABC' },
    });
    expect(prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('rejects wallet linking for non-Google accounts, invalid signatures, and other owners', async () => {
    const dto = { stellarAddress: 'GABC', nonce: 'nonce', signature: 'sig' };
    await expect(controller.linkWallet({ id: 'user-1' } as any, dto as any, request)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    authService.verifySignature.mockReturnValue(false);
    await expect(
      controller.linkWallet({ id: 'user-1', googleId: 'google-1' } as any, dto as any, request),
    ).rejects.toThrow('Invalid signature');

    authService.verifySignature.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({ id: 'other-user' });
    await expect(
      controller.linkWallet({ id: 'user-1', googleId: 'google-1' } as any, dto as any, request),
    ).rejects.toThrow('This wallet is already linked to another account');
  });

  it('unlinks a wallet only for a Google account that has one linked', async () => {
    await expect(controller.unlinkWallet({ id: 'user-1' } as any, request)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.unlinkWallet({ id: 'user-1', googleId: 'google-1', stellarAddress: null } as any, request),
    ).rejects.toThrow('No wallet is currently linked');

    await expect(
      controller.unlinkWallet({ id: 'user-1', googleId: 'google-1', stellarAddress: 'GABC' } as any, request),
    ).resolves.toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { stellarAddress: null },
    });
  });
});
