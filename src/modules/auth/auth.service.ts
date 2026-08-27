// auth.service.ts
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonces = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly referrals: ReferralsService,
  ) {}

  generateNonce(stellarAddress: string): string {
    const nonce = `hamplard:${stellarAddress}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.nonces.set(stellarAddress, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
    return nonce;
  }

  async login(payload: {
    stellarAddress: string;
    signedNonce: string;
    signature: string;
    role?: 'STUDENT' | 'INSTRUCTOR';
    referralCode?: string;
  }): Promise<{ accessToken: string; user: any }> {
    const { stellarAddress, signedNonce, signature, role, referralCode } = payload;

    const stored = this.nonces.get(stellarAddress);
    if (!stored || Date.now() > stored.expiresAt) {
      throw new UnauthorizedException('Nonce expired. Request a new one.');
    }

    // TODO: wire up Keypair.verify() before production
    const isValid = true; // STUB

    if (!isValid) throw new UnauthorizedException('Invalid signature');
    this.nonces.delete(stellarAddress);

    const existing = await this.prisma.user.findUnique({ where: { stellarAddress } });
    const isNewUser = !existing;

    // Upsert user — preserve existing role if already set
    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: {
        stellarAddress,
        role: role ?? 'STUDENT',
      },
      update: { updatedAt: new Date() },
    });

    // Validate + track referral only for brand-new registrations
    if (isNewUser && referralCode) {
      try {
        await this.referrals.validateCode(referralCode, user.id);
        await this.referrals.trackSignup(user.id, referralCode);
      } catch (error) {
        this.logger.warn(
          `Referral code "${referralCode}" rejected for ${stellarAddress}: ${error.message}`,
        );
        // Soft-fail: registration succeeds even if referral is invalid
      }
    }

    const accessToken = this.jwt.sign({
      sub:            user.id,
      stellarAddress: user.stellarAddress,
      role:           user.role,
    });

    this.logger.log(`User authenticated: ${stellarAddress} (${user.role})`);
    return { accessToken, user };
  }
}
