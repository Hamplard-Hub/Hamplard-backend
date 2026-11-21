import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { RedisRateLimitService } from '../../common/redis-rate-limit/redis-rate-limit.service';

interface AttemptState {
  failures: number;
  blockedUntil?: number;
}

/** Redis key prefix for CAPTCHA attempt state. */
const KEY_PREFIX = 'captcha:attempt:';

@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  private readonly secretKey: string;
  private readonly verifyUrl: string;
  private readonly timeoutMs: number;
  private readonly maxFailures: number;
  private readonly blockDurationMs: number;
  /** TTL (seconds) used when persisting attempt state to Redis. */
  private readonly stateTtlSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly rl: RedisRateLimitService,
  ) {
    this.secretKey = this.config.get<string>('CAPTCHA_SECRET_KEY', '');
    this.verifyUrl = this.config.get<string>(
      'CAPTCHA_VERIFY_URL',
      'https://www.google.com/recaptcha/api/siteverify',
    );
    this.timeoutMs        = this.readNumber('CAPTCHA_TIMEOUT_MS',             5_000);
    this.maxFailures      = this.readNumber('CAPTCHA_MAX_FAILURES',           5);
    this.blockDurationMs  = this.readNumber('CAPTCHA_BLOCK_DURATION_SECONDS', 900) * 1_000;
    // Keep the state key alive a little longer than the block so it's
    // accessible throughout the full block window.
    this.stateTtlSeconds  = Math.ceil(this.blockDurationMs / 1_000) + 60;
  }

  /**
   * Verify a CAPTCHA token with the configured provider before a nonce is issued.
   * Client-reported success flags are ignored; only the provider response is trusted.
   */
  async verifyBeforeNonce(token: string | undefined, ip: string): Promise<void> {
    const clientIp = ip || 'unknown';
    await this.assertNotBlocked(clientIp);

    const captchaToken = token?.trim();
    if (!captchaToken) {
      await this.rejectFailedAttempt(
        clientIp,
        new BadRequestException('CAPTCHA token is required'),
      );
    }

    if (!this.secretKey) {
      this.logger.error('CAPTCHA_SECRET_KEY is not configured; refusing nonce issuance');
      throw new ServiceUnavailableException('CAPTCHA verification is unavailable');
    }

    let payload: { success?: boolean };
    try {
      const params = new URLSearchParams();
      params.append('secret', this.secretKey);
      params.append('response', captchaToken!);
      if (clientIp !== 'unknown') {
        params.append('remoteip', clientIp);
      }

      const response = await axios.post(this.verifyUrl, params.toString(), {
        timeout: this.timeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        this.logger.warn(`CAPTCHA provider returned HTTP ${response.status}`);
        throw new ServiceUnavailableException('CAPTCHA verification is unavailable');
      }

      payload = response.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;

      const axiosError = error as AxiosError;
      this.logger.warn(
        `CAPTCHA provider request failed: ${axiosError?.message ?? 'unknown error'}`,
      );
      throw new ServiceUnavailableException('CAPTCHA verification is unavailable');
    }

    if (payload?.success === true) {
      // Clear failure state on success.
      await this.rl.del(`${KEY_PREFIX}${clientIp}`);
      return;
    }

    if (payload?.success === false) {
      await this.rejectFailedAttempt(
        clientIp,
        new UnauthorizedException('CAPTCHA verification failed'),
      );
    }

    this.logger.warn('CAPTCHA provider returned an unexpected payload; refusing nonce issuance');
    throw new ServiceUnavailableException('CAPTCHA verification is unavailable');
  }

  private async assertNotBlocked(ip: string): Promise<void> {
    const state = await this.getState(ip);
    if (state.blockedUntil && Date.now() < state.blockedUntil) {
      throw new HttpException(
        'Too many failed CAPTCHA attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async rejectFailedAttempt(ip: string, exception: Error): Promise<never> {
    const state = await this.getState(ip);
    state.failures += 1;

    if (state.failures >= this.maxFailures) {
      state.blockedUntil = Date.now() + this.blockDurationMs;
      await this.rl.setJson(`${KEY_PREFIX}${ip}`, state, this.stateTtlSeconds);
      this.logger.warn(
        `Temporarily blocking IP after ${state.failures} failed CAPTCHA attempts`,
      );
      throw new HttpException(
        'Too many failed CAPTCHA attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.rl.setJson(`${KEY_PREFIX}${ip}`, state, this.stateTtlSeconds);
    throw exception;
  }

  private async getState(ip: string): Promise<AttemptState> {
    const existing = await this.rl.getJson<AttemptState>(`${KEY_PREFIX}${ip}`);
    if (!existing) return { failures: 0 };

    // Auto-clear an expired block so we return a clean slate.
    if (existing.blockedUntil && Date.now() >= existing.blockedUntil) {
      return { failures: 0 };
    }

    return existing;
  }

  private readNumber(key: string, fallback: number): number {
    const value  = this.config.get<string | number>(key, fallback);
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
