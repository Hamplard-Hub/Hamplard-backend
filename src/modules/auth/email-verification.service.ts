import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface VerificationTokenPayload {
  sub: string;
  purpose: 'email_verification';
  email: string;
}

const VERIFICATION_PURPOSE = 'email_verification';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly resendTimestamps = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async requestVerification(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!user.email) {
      throw new BadRequestException('No email address associated with this account');
    }

    if (user.emailVerifiedAt) {
      return { message: 'Email is already verified' };
    }

    const now = Date.now();
    const lastResent = this.resendTimestamps.get(userId);
    const cooldownMinutes = this.config.get<number>(
      'DATA_EXPORT_RATE_LIMIT_WINDOW_MINUTES',
      60,
    );
    const cooldownMs = cooldownMinutes * 60 * 1000;

    if (lastResent && now - lastResent < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - (now - lastResent)) / 1000);
      throw new BadRequestException(
        `Please wait ${waitSeconds} seconds before requesting another verification email`,
      );
    }

    const token = this.generateVerificationToken(user.id, user.email);
    const baseUrl = this.config.get<string>(
      'EMAIL_VERIFICATION_BASE_URL',
      'http://localhost:3000/verify-email',
    );
    const verificationUrl = `${baseUrl}?token=${token}`;

    try {
      await this.sendVerificationEmail(
        user.email,
        user.name ?? 'there',
        verificationUrl,
      );
      this.resendTimestamps.set(userId, now);
      this.logger.log(`Verification email sent to ${user.email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${user.email}`,
        error.message,
      );
      throw new BadRequestException('Failed to send verification email');
    }

    return { message: 'Verification email sent' };
  }

  async confirmVerification(token: string): Promise<{ message: string; verified: boolean }> {
    const payload = this.verifyToken(token);

    if (payload.purpose !== VERIFICATION_PURPOSE) {
      throw new UnauthorizedException('Invalid verification token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.emailVerifiedAt) {
      return { message: 'Email is already verified', verified: true };
    }

    if (user.email?.toLowerCase() !== payload.email.toLowerCase()) {
      throw new UnauthorizedException('Email address has changed since verification was requested');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), isVerified: true },
    });

    this.logger.log(`Email verified for user ${user.id}`);
    return { message: 'Email verified successfully', verified: true };
  }

  generateVerificationToken(userId: string, email: string): string {
    const expiresIn = this.config.get<string>(
      'EMAIL_VERIFICATION_EXPIRES_IN',
      '86400',
    );

    return this.jwt.sign(
      {
        sub: userId,
        purpose: VERIFICATION_PURPOSE,
        email,
      } satisfies VerificationTokenPayload,
      {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: parseInt(expiresIn, 10),
      },
    );
  }

  verifyToken(token: string): VerificationTokenPayload {
    try {
      const payload = this.jwt.verify<VerificationTokenPayload>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });

      if (payload.purpose !== VERIFICATION_PURPOSE) {
        throw new UnauthorizedException('Invalid token purpose');
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired verification token');
    }
  }

  async getVerificationStatus(userId: string): Promise<{ emailVerified: boolean; emailVerifiedAt: Date | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    return {
      emailVerified: !!user.emailVerifiedAt,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }

  private async sendVerificationEmail(
    to: string,
    name: string,
    verificationUrl: string,
  ): Promise<void> {
    const platformName = this.config.get('PLATFORM_NAME', 'Hamplard');

    await (this.notifications as any).transporter.sendMail({
      from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
      to,
      subject: `Verify your email address — ${platformName}`,
      text: `Hi ${name}, please verify your email by visiting: ${verificationUrl}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#059669;">${platformName}</h2>
          <p style="color:#444;line-height:1.6;">Hi ${name},</p>
          <p style="color:#444;line-height:1.6;">
            Please verify your email address by clicking the link below:
          </p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${verificationUrl}"
               style="background-color:#059669;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">
              Verify Email Address
            </a>
          </p>
          <p style="color:#666;font-size:14px;line-height:1.6;">
            This link will expire in 24 hours. If you did not request this verification, you can safely ignore this email.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <small style="color:#999;">
            You're receiving this because you have an account on ${platformName}.
          </small>
        </div>
      `,
    });
  }
}
