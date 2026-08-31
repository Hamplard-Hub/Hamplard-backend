// two-factor.service.ts
import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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
  // LOGIN-TIME VERIFICATION — TOTP code or a single-use recovery code
  // ------------------------------------------------------------------

  async verifyLoginCode(userId: string, code: string): Promise<boolean> {
    return this.verifyCode(userId, code);
  }

  private async verifyCode(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorSecret) return false;

    if (this.verifyTotp(user.twoFactorSecret, code)) {
      return true;
    }

    const hashedInput = this.hashRecoveryCode(code);
    const codeIndex = user.twoFactorRecoveryCodes.indexOf(hashedInput);
    if (codeIndex === -1) return false;

    // Recovery codes are single-use — remove the consumed one.
    const remainingCodes = [...user.twoFactorRecoveryCodes];
    remainingCodes.splice(codeIndex, 1);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: remainingCodes },
    });

    return true;
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
