import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
  TooManyRequestsException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as africastalking from 'africastalking';

const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const OTP_RATE_LIMIT_MAX_REQUESTS = 3; // max 3 OTP requests per minute per phone

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly smsClient: any;
  private readonly rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const username = this.config.get<string>('AFRICASTALKING_USERNAME');
    const apiKey = this.config.get<string>('AFRICASTALKING_API_KEY');

    if (!username || !apiKey) {
      this.logger.warn(
        'Africa\'s Talking credentials not configured. SMS functionality will be disabled.',
      );
    } else {
      this.smsClient = africastalking({ username, apiKey }).SMS;
    }
  }

  /**
   * Generate a random 6-digit OTP
   */
  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Check rate limiting for OTP requests
   */
  private checkRateLimit(phoneNumber: string): void {
    const now = Date.now();
    const record = this.rateLimitMap.get(phoneNumber);

    if (!record || now > record.resetAt) {
      // Reset or create new rate limit window
      this.rateLimitMap.set(phoneNumber, {
        count: 1,
        resetAt: now + OTP_RATE_LIMIT_WINDOW_MS,
      });
      return;
    }

    if (record.count >= OTP_RATE_LIMIT_MAX_REQUESTS) {
      const remainingSeconds = Math.ceil((record.resetAt - now) / 1000);
      throw new TooManyRequestsException(
        `Too many OTP requests. Please try again in ${remainingSeconds} seconds.`,
      );
    }

    record.count += 1;
  }

  /**
   * Send OTP to phone number via Africa's Talking SMS
   */
  async sendOtp(userId: string, phoneNumber: string, countryCode: string): Promise<void> {
    // Rate limit check
    this.checkRateLimit(phoneNumber);

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

    // Generate new OTP
    const otp = this.generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Store OTP in database
    await this.prisma.phoneOtp.create({
      data: {
        userId,
        phoneNumber,
        countryCode,
        otp,
        expiresAt,
      },
    });

    // Send SMS
    if (!this.smsClient) {
      this.logger.warn(`SMS client not configured. OTP for ${phoneNumber}: ${otp}`);
      // In development, log the OTP (remove in production)
      if (this.config.get<string>('NODE_ENV') === 'development') {
        this.logger.log(`[DEV] OTP for ${phoneNumber}: ${otp}`);
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
   * Verify OTP submitted by user
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

    // Verify OTP
    if (otpRecord.otp !== otpCode) {
      // Increment attempt count
      await this.prisma.phoneOtp.update({
        where: { id: otpRecord.id },
        data: {
          attemptCount: otpRecord.attemptCount + 1,
        },
      });

      const remainingAttempts = OTP_MAX_ATTEMPTS - (otpRecord.attemptCount + 1);
      throw new UnauthorizedException(
        `Invalid OTP. ${remainingAttempts} attempts remaining.`,
      );
    }

    // OTP is valid - mark as used and verified
    await this.prisma.phoneOtp.update({
      where: { id: otpRecord.id },
      data: {
        isUsed: true,
        verifiedAt: new Date(),
      },
    });

    // Update user's phone verification status
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber,
        phoneCountryCode: otpRecord.countryCode,
        isPhoneVerified: true,
        phoneVerifiedAt: new Date(),
      },
    });

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
