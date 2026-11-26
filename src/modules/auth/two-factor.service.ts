// two-factor.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisRateLimitService } from '../../common/redis-rate-limit/redis-rate-limit.service';

const RECOVERY_CODE_COUNT = 10;

/** Default number of failed TOTP/recovery-code attempts before an account is locked. */
const DEFAULT_TOTP_MAX_FAILED_ATTEMPTS = 5;
/** Default lockout duration, in seconds, once the failure threshold is reached. */
const DEFAULT_TOTP_LOCKOUT_SECONDS = 15 * 60;

const TOTP_ATTEMPTS_KEY_PREFIX = 'auth:2fa:failed:';
const TOTP_LOCKOUT_KEY_PREFIX = 'auth:2fa:lockout:';

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  private readonly maxFailedAttempts: number;
  private readonly lockoutSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly rateLimit: RedisRateLimitService,
  ) {
    this.maxFailedAttempts = this.readPositiveNumber(
      'TOTP_MAX_FAILED_ATTEMPTS',
      DEFAULT_TOTP_MAX_FAILED_ATTEMPTS,
    );
    this.lockoutSeconds = this.readPositiveNumber(
      'TOTP_LOCKOUT_SECONDS',
      DEFAULT_TOTP_LOCKOUT_SECONDS,
    );
  }

  // ------------------------------------------------------------------
  // SETUP — generate a TOTP secret and QR enrollment payload
  // ------------------------------------------------------------------

  async generateSecret(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled for this account');
    }

    const issuer = this.config.get<string>('PLATFORM_NAME', 'Hamplard');
    const label = user.email ?? user.stellarAddress ?? user.id;

    const secret = speakeasy.generateSecret({
      length: 20,
      name: `${issuer} (${label})`,
      issuer,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret.base32 },
    });

    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url as string);

    return {
      secret: secret.base32,
      otpauthUrl: secret.otpauth_url,
      qrCodeDataUrl,
    };
  }

  // ------------------------------------------------------------------
  // ENABLE — confirm setup with a valid TOTP code, issue recovery codes
  // ------------------------------------------------------------------

  async enable(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.twoFactorSecret) {
      throw new BadRequestException('Call the setup endpoint to generate a secret before enabling 2FA');
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled for this account');
    }

    const isValid = this.verifyTotp(user.twoFactorSecret, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }

    const { plainCodes, hashedCodes } = this.generateRecoveryCodes();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorEnabledAt: new Date(),
        twoFactorRecoveryCodes: hashedCodes,
      },
    });

    return { enabled: true, recoveryCodes: plainCodes };
  }

  // ------------------------------------------------------------------
  // DISABLE — turn 2FA off after re-confirming a code
  // ------------------------------------------------------------------

  async disable(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled for this account');
    }

    const isValid = await this.verifyCode(user.id, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorEnabledAt: null,
        twoFactorSecret: null,
        twoFactorRecoveryCodes: [],
      },
    });

    return { enabled: false };
  }

  // ------------------------------------------------------------------
  // STATUS
  // ------------------------------------------------------------------

  async getStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorEnabledAt: true },
    });
    if (!user) throw new NotFoundException('User not found');

    return { enabled: user.twoFactorEnabled, enabledAt: user.twoFactorEnabledAt };
  }

  // ------------------------------------------------------------------
  // REGENERATE RECOVERY CODES
  // ------------------------------------------------------------------

  /**
   * Regenerate recovery codes after confirming a valid TOTP code.
   * Old recovery codes are immediately invalidated.
   */
  async regenerateRecoveryCodes(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled for this account');
    }

    // Verify TOTP code (not recovery code — must use authenticator app)
    const isValid = this.verifyTotp(user.twoFactorSecret, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }

    // Generate new recovery codes
    const { plainCodes, hashedCodes } = this.generateRecoveryCodes();

    // Replace old codes with new ones
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: hashedCodes },
    });

    this.logger.log(`Recovery codes regenerated for user ${userId}`);

    return { recoveryCodes: plainCodes };
  }

  // ------------------------------------------------------------------
  // LOGIN-TIME VERIFICATION — TOTP code or a single-use recovery code
  // ------------------------------------------------------------------

  /**
   * Verify a code presented at login (Stellar or Google ID-token login).
   *
   * Failure counting is centralised here so the same per-account lockout also
   * applies when the code is presented to POST /auth/2fa/disable.
   */
  async verifyLoginCode(userId: string, code: string): Promise<boolean> {
    return this.verifyCode(userId, code);
  }

  /**
   * Reject an account that is currently locked out. Exposed so callers that
   * need to check before prompting for a code can do so, but verifyCode()
   * already enforces this for every TOTP check.
   */
  async assertNotLockedOut(userId: string): Promise<void> {
    let blockedUntil: number | null = null;
    try {
      blockedUntil = await this.rateLimit.getJson<number>(this.lockoutKey(userId));
    } catch (error) {
      // An unavailable counter store must not turn into a platform-wide lockout.
      this.logger.warn(
        `Could not read 2FA lockout state for ${userId}: ${(error as Error).message}`,
      );
      return;
    }

    if (blockedUntil === null || blockedUntil === undefined) return;

    if (Date.now() < blockedUntil) {
      throw this.lockoutException(blockedUntil);
    }

    // Lockout has expired but the key has not been pruned yet — start clean.
    await this.resetFailedAttempts(userId);
  }

  private async verifyCode(userId: string, code: string): Promise<boolean> {
    await this.assertNotLockedOut(userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorSecret) return false;

    if (this.verifyTotp(user.twoFactorSecret, code)) {
      await this.resetFailedAttempts(userId);
      return true;
    }

    const hashedInput = this.hashRecoveryCode(code);
    const codeIndex = user.twoFactorRecoveryCodes.indexOf(hashedInput);
    if (codeIndex === -1) {
      // Count the failed attempt. The Nth failure throws a 429 lockout error;
      // earlier failures return false so existing callers keep their 401 flow.
      await this.recordFailedAttempt(userId);
      return false;
    }

    // Recovery codes are single-use — remove the consumed one.
    const remainingCodes = [...user.twoFactorRecoveryCodes];
    remainingCodes.splice(codeIndex, 1);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: remainingCodes },
    });

    await this.resetFailedAttempts(userId);
    return true;
  }

  // ------------------------------------------------------------------
  // PER-ACCOUNT TOTP ATTEMPT LIMITING
  // ------------------------------------------------------------------

  /** Redis key holding the fixed-window count of failed attempts for a user. */
  private attemptKey(userId: string): string {
    return `${TOTP_ATTEMPTS_KEY_PREFIX}${userId}`;
  }

  /** Redis key holding the timestamp until which a user is locked out. */
  private lockoutKey(userId: string): string {
    return `${TOTP_LOCKOUT_KEY_PREFIX}${userId}`;
  }

  /**
   * Atomically increment the per-user failure counter. When the configured
   * threshold is reached, write a lockout marker with its own TTL and reject
   * the attempt with HTTP 429 so the caller does not issue a token.
   */
  private async recordFailedAttempt(userId: string): Promise<void> {
    try {
      const { count } = await this.rateLimit.fixedWindow(
        this.attemptKey(userId),
        this.lockoutSeconds,
      );

      if (count < this.maxFailedAttempts) return;

      const blockedUntil = Date.now() + this.lockoutSeconds * 1000;
      await this.rateLimit.setJson(
        this.lockoutKey(userId),
        blockedUntil,
        this.lockoutSeconds,
      );

      this.logger.warn(
        `User ${userId} locked out after ${count} failed two-factor attempts`,
      );
      throw this.lockoutException(blockedUntil);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(
        `Could not record 2FA failure for ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /** Clear failure state after a successful code or an expired lockout. */
  private async resetFailedAttempts(userId: string): Promise<void> {
    await Promise.all([
      this.rateLimit.del(this.attemptKey(userId)),
      this.rateLimit.del(this.lockoutKey(userId)),
    ]);
  }

  private lockoutException(blockedUntil: number): HttpException {
    const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
    return new HttpException(
      `Too many failed two-factor attempts. Try again in ${retryAfterSeconds} seconds.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const value = this.config.get<string | number>(key, fallback);
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private verifyTotp(secret: string, code: string): boolean {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
  }

  private generateRecoveryCodes(): { plainCodes: string[]; hashedCodes: string[] } {
    const plainCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomBytes(5).toString('hex').toUpperCase();
      const formatted = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
      plainCodes.push(formatted);
      hashedCodes.push(this.hashRecoveryCode(formatted));
    }

    return { plainCodes, hashedCodes };
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
  }
}
