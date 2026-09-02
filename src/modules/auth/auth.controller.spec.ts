import {
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

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    generateNonce: jest.fn().mockReturnValue('issued-nonce'),
    login: jest.fn(),
  };
  const captchaService = {
    verifyBeforeNonce: jest.fn().mockResolvedValue(undefined),
  };

  const request = { ip: '203.0.113.10', socket: { remoteAddress: '203.0.113.10' } } as Request;

  beforeEach(async () => {
    jest.clearAllMocks();
    captchaService.verifyBeforeNonce.mockResolvedValue(undefined);
    authService.generateNonce.mockReturnValue('issued-nonce');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: CaptchaService, useValue: captchaService },
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
});
