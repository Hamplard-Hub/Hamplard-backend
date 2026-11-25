import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { randomInt, createHmac, timingSafeEqual } from 'crypto';
import { RedisRateLimitService } from '../../common/redis-rate-limit/redis-rate-limit.service';

export class TooManyRequestsException extends HttpException {
  constructor(message: string = 'Too Many Requests') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
import * as africastalking from 'africastalking';

const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const OTP_RATE_LIMIT_MAX_REQUESTS = 3; // max 3 OTP requests per minute per phone

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly smsClient: any;
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly rl: RedisRateLimitService,
  ) {
    const username = this.config.get<string>('AFRICASTALKING_USERNAME');
    const apiKey = this.config.get<string>('AFRICASTALKING_API_KEY');

    if (!username || !apiKey) {
      this.logger.warn(
        "Africa's Talking credentials not configured. SMS functionality will be disabled.",
      );
    } else {
      this.smsClient = africastalking({ username, apiKey }).SMS;
    }

    // OTP_HMAC_SECRET must be set in production. Fall back only in development.
    this.hmacSecret =
      this.config.get<string>('OTP_HMAC_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'dev-only-fallback-secret';
  }

  /**
   * Generate a cryptographically secure 6-digit OTP using crypto.randomInt.
   */
  private generateOtp(): string {
    // randomInt(min, max) returns an integer in [min, max)
    return randomInt(100_000, 1_000_000).toString();
  }

  /**
   * Derive an HMAC-SHA256 hash of the OTP code so it is never stored in plaintext.
   */
  private hashOtp(otp: string): string {
    return createHmac('sha256', this.hmacSecret).update(otp).digest('hex');
  }

  /**
   * Constant-time comparison of the submitted OTP against the stored HMAC hash.
   */
  private verifyOtpHash(submitted: string, storedHash: string): boolean {
    const submittedHash = this.hashOtp(submitted);
    const a = Buffer.from(submittedHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Check rate limiting for OTP requests using a Redis fixed-window counter.
   * Key: otp:rl:<phoneNumber>, TTL = OTP_RATE_LIMIT_WINDOW_MS / 1000.
   */
  private async checkRateLimit(phoneNumber: string): Promise<void> {
    const windowSeconds = Math.ceil(OTP_RATE_LIMIT_WINDOW_MS / 1000);
    const key = `otp:rl:${phoneNumber}`;

    const { count, ttlSeconds } = await this.rl.fixedWindow(key, windowSeconds);

    if (count > OTP_RATE_LIMIT_MAX_REQUESTS) {
      throw new TooManyRequestsException(
        `Too many OTP requests. Please try again in ${ttlSeconds} seconds.`,
      );
    }
  }

  /**
   * Send OTP to phone number via Africa's Talking SMS.
   * The plaintext code is never written to the database; only an HMAC hash is stored.
   * Outside NODE_ENV=development the code is also never written to logs.
   */
  async sendOtp(userId: string, phoneNumber: string, countryCode: string): Promise<void> {
    // Rate limit check
    await this.checkRateLimit(phoneNumber);

    // Invalidate any existing unused OTPs for this user and phone
    await this.prisma.phoneOtp.updateMany({
      where: {
        userId,
        phoneNumber,
        isUsed: false,
      },
      data: {
        isUsed: true,
      },
    });

    // Generate new OTP with crypto.randomInt (CSPRNG)
    const otp = this.generateOtp();
    const otpHash = this.hashOtp(otp);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store only the HMAC hash — never the plaintext code
    await this.prisma.phoneOtp.create({
      data: {
        userId,
        phoneNumber,
        countryCode,
        otp: otpHash,
        expiresAt,
      },
    });

    // Send SMS
    if (!this.smsClient) {
      // Only reveal the OTP in development; never log it in other environments
      if (this.config.get<string>('NODE_ENV') === 'development') {
        this.logger.debug(`[DEV] SMS client not configured. OTP for ${phoneNumber}: ${otp}`);
      } else {
        this.logger.warn('SMS client not configured. OTP was generated but not delivered.');
      }
      return;
    }

    try {
      const senderId = this.config.get<string>('AFRICASTALKING_SENDER_ID', 'Hamplard');
      const message = `Your Hamplard verification code is: ${otp}. Valid for ${OTP_EXPIRY_MINUTES} minutes.`;

      await this.smsClient.send({
        to: [phoneNumber],
        message,
        from: senderId,
      });

      this.logger.log(`OTP sent successfully to ${phoneNumber}`);
    } catch (error) {
      this.logger.error(`Failed to send OTP to ${phoneNumber}:`, error);
      throw new BadRequestException('Failed to send OTP. Please try again.');
    }
  }

  /**
   * Verify OTP submitted by user using constant-time HMAC comparison.
   */
  async verifyOtp(userId: string, phoneNumber: string, otpCode: string): Promise<boolean> {
    // Find the most recent unused OTP for this user and phone
    const otpRecord = await this.prisma.phoneOtp.findFirst({
      where: {
        userId,
        phoneNumber,
        isUsed: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!otpRecord) {
      throw new UnauthorizedException('No valid OTP found. Please request a new one.');
    }

    // Check expiry
    if (new Date() > otpRecord.expiresAt) {
      await this.prisma.phoneOtp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });
      throw new UnauthorizedException('OTP has expired. Please request a new one.');
    }

    // Check attempt count
    if (otpRecord.attemptCount >= OTP_MAX_ATTEMPTS) {
      await this.prisma.phoneOtp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });
      throw new UnauthorizedException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    // Reserve an attempt atomically before checking the submitted code.
    const attempt = await this.prisma.phoneOtp.updateMany({
      where: {
        id: otpRecord.id,
        isUsed: false,
        attemptCount: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { attemptCount: { increment: 1 } },
    });

    if (attempt.count !== 1) {
      await this.prisma.phoneOtp.updateMany({
        where: {
          id: otpRecord.id,
          isUsed: false,
          attemptCount: { gte: OTP_MAX_ATTEMPTS },
        },
        data: { isUsed: true },
      });
      throw new UnauthorizedException(
        'Maximum verification attempts exceeded. Please request a new OTP.',
      );
    }

    // Constant-time HMAC comparison — storedHash vs hash(submitted)
    const isValid = this.verifyOtpHash(otpCode, otpRecord.otp);

    if (!isValid) {
      await this.prisma.phoneOtp.updateMany({
        where: {
          id: otpRecord.id,
          isUsed: false,
          attemptCount: { gte: OTP_MAX_ATTEMPTS },
        },
        data: { isUsed: true },
      });
      throw new UnauthorizedException(
        'Invalid OTP.',
      );
    }

    const verifiedOwner = await this.prisma.user.findFirst({
      where: {
        phoneNumber,
        isPhoneVerified: true,
        deletedAt: null,
        deactivatedAt: null,
        id: { not: userId },
      },
      select: { id: true },
    });

    if (verifiedOwner) {
      throw new ConflictException('Phone number is already verified by another account.');
    }

    // The partial unique index also protects concurrent verifications. Keep the
    // user update and OTP consumption atomic so a conflict leaves the OTP unused.
    try {
      await this.prisma.$transaction(async (tx) => {
        const verifiedAt = new Date();
        await tx.user.update({
          where: { id: userId },
          data: {
            phoneNumber,
            phoneCountryCode: otpRecord.countryCode,
            isPhoneVerified: true,
            phoneVerifiedAt: verifiedAt,
          },
        });
        await tx.phoneOtp.update({
          where: { id: otpRecord.id },
          data: { isUsed: true, verifiedAt },
        });
      });
    } catch (error) {
      const target = error instanceof Prisma.PrismaClientKnownRequestError
        ? error.meta?.target
        : undefined;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        ((Array.isArray(target) && target.includes('phoneNumber')) ||
          target === 'users_active_verified_phone_key')
      ) {
        throw new ConflictException('Phone number is already verified by another account.');
      }
      throw error;
    }

    this.logger.log(`Phone ${phoneNumber} verified successfully for user ${userId}`);
    return true;
  }

  /**
   * Get phone verification status for a user
   */
  async getVerificationStatus(userId: string): Promise<{
    isPhoneVerified: boolean;
    phoneNumber: string | null;
    phoneVerifiedAt: Date | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isPhoneVerified: true,
        phoneNumber: true,
        phoneVerifiedAt: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    return {
      isPhoneVerified: user.isPhoneVerified,
      phoneNumber: user.phoneNumber,
      phoneVerifiedAt: user.phoneVerifiedAt,
    };
  }
}
