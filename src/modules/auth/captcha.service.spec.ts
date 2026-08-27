import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { CaptchaService } from './captcha.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (err) => err,
  );
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
}

describe('CaptchaService', () => {
  let service: CaptchaService;
  const configMap: Record<string, string | number> = {
    CAPTCHA_SECRET_KEY: 'test-secret',
    CAPTCHA_VERIFY_URL: 'https://captcha.test/siteverify',
    CAPTCHA_TIMEOUT_MS: 2000,
    CAPTCHA_MAX_FAILURES: 3,
    CAPTCHA_BLOCK_DURATION_SECONDS: 900,
  };

  async function createService(overrides: Record<string, string | number | undefined> = {}) {
    const merged = { ...configMap, ...overrides };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CaptchaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) =>
              merged[key] !== undefined ? merged[key] : defaultValue,
            ),
          },
        },
      ],
    }).compile();

    return module.get(CaptchaService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await createService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a token after the provider confirms success', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });

    await expect(service.verifyBeforeNonce('valid-token', '1.1.1.1')).resolves.toBeUndefined();

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://captcha.test/siteverify',
      expect.stringContaining('secret=test-secret'),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = mockedAxios.post.mock.calls[0][1] as string;
    expect(body).toContain('response=valid-token');
    expect(body).toContain('remoteip=1.1.1.1');
  });

  it('rejects an invalid token without treating client flags as proof', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: false } });

    await expect(service.verifyBeforeNonce('bad-token', '2.2.2.2')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a missing token and counts it as a failed attempt', async () => {
    await expect(service.verifyBeforeNonce(undefined, '3.3.3.3')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('blocks the IP after repeated failed verifications', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: false } });

    await expect(service.verifyBeforeNonce('t1', '4.4.4.4')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.verifyBeforeNonce('t2', '4.4.4.4')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expectHttpStatus(
      service.verifyBeforeNonce('t3', '4.4.4.4'),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('does not contact the provider while the IP is temporarily blocked', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: false } });

    await service.verifyBeforeNonce('t1', '5.5.5.5').catch(() => undefined);
    await service.verifyBeforeNonce('t2', '5.5.5.5').catch(() => undefined);
    await service.verifyBeforeNonce('t3', '5.5.5.5').catch(() => undefined);
    mockedAxios.post.mockClear();

    await expectHttpStatus(
      service.verifyBeforeNonce('still-bad', '5.5.5.5'),
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('allows a new attempt after the temporary block expires', async () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: false } });

    await service.verifyBeforeNonce('t1', '6.6.6.6').catch(() => undefined);
    await service.verifyBeforeNonce('t2', '6.6.6.6').catch(() => undefined);
    await service.verifyBeforeNonce('t3', '6.6.6.6').catch(() => undefined);

    (Date.now as jest.Mock).mockReturnValue(now + 901_000);
    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });

    await expect(service.verifyBeforeNonce('good-token', '6.6.6.6')).resolves.toBeUndefined();
  });

  it('does not issue success when the provider request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.verifyBeforeNonce('token', '7.7.7.7')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not treat a provider HTTP error as a successful verification', async () => {
    mockedAxios.post.mockResolvedValue({ status: 500, data: { success: true } });

    await expect(service.verifyBeforeNonce('token', '8.8.8.8')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not increment failure blocks when the provider is down', async () => {
    mockedAxios.post.mockRejectedValue(new Error('timeout'));

    await service.verifyBeforeNonce('token', '9.9.9.9').catch(() => undefined);
    await service.verifyBeforeNonce('token', '9.9.9.9').catch(() => undefined);
    await service.verifyBeforeNonce('token', '9.9.9.9').catch(() => undefined);

    mockedAxios.post.mockResolvedValue({ status: 200, data: { success: true } });
    await expect(service.verifyBeforeNonce('token', '9.9.9.9')).resolves.toBeUndefined();
  });

  it('fails closed when the CAPTCHA secret is not configured', async () => {
    service = await createService({ CAPTCHA_SECRET_KEY: '' });

    await expect(service.verifyBeforeNonce('token', '10.10.10.10')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('clears failed attempts after a successful verification', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ status: 200, data: { success: false } })
      .mockResolvedValueOnce({ status: 200, data: { success: false } })
      .mockResolvedValueOnce({ status: 200, data: { success: true } })
      .mockResolvedValueOnce({ status: 200, data: { success: false } });

    await service.verifyBeforeNonce('bad', '11.11.11.11').catch(() => undefined);
    await service.verifyBeforeNonce('bad', '11.11.11.11').catch(() => undefined);
    await expect(service.verifyBeforeNonce('good', '11.11.11.11')).resolves.toBeUndefined();

    await expect(service.verifyBeforeNonce('bad-again', '11.11.11.11')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
