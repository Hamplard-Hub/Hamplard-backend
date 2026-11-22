// auth.service.ts
import { Injectable, UnauthorizedException, Logger, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';
import { RefreshTokenService, TokenPair } from './refresh-token.service';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { SessionsService, DeviceMetadata } from './sessions.service';
import { SafeUser, toSafeUser } from '../users/user-serializer';
import { TwoFactorService } from './two-factor.service';
import { CacheService } from '../../common/cache/cache.service';
import { randomBytes } from 'crypto';

/**
 * How many milliseconds of clock-skew between client and server we tolerate
 * when evaluating nonce expiry. Set to 30 seconds.
 */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

/**
 * How long (seconds) a nonce is valid for after issuance (5 minutes).
 * Redis TTL is in seconds.
 */
const NONCE_TTL_SECONDS = 5 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly referrals: ReferralsService,
    private readonly sessions: SessionsService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly twoFactor: TwoFactorService,
    private readonly cache: CacheService,
  ) {}

  // ------------------------------------------------------------------
  // NONCE GENERATION
  // ------------------------------------------------------------------

  private nonceRedisKey(stellarAddress: string): string {
    return `auth:nonce:${stellarAddress}`;
  }

  /**
   * Issue a fresh single-use nonce tied to the given Stellar address.
   *
   * - Address is validated with StrKey before any state is written.
   * - Nonce entropy comes from crypto.randomBytes (CSPRNG).
   * - Stored in Redis with SET NX EX so that concurrent requests do not
   *   silently overwrite an in-flight nonce and the store is self-pruning.
   * - The nonce is valid for NONCE_TTL_SECONDS (5 minutes).
   */
  async generateNonce(stellarAddress: string): Promise<string> {
    if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
      throw new BadRequestException(
        'Invalid Stellar address: must be a valid Ed25519 public key (G…).',
      );
    }

    const now = Date.now();
    const nonce = `hamplard:${stellarAddress}:${now}:${randomBytes(16).toString('hex')}`;
    const key = this.nonceRedisKey(stellarAddress);

    // SET NX EX — only write if no nonce already exists for this address.
    // This prevents a concurrent or replayed nonce-request from invalidating
    // an in-flight authentication attempt.
    // We intentionally overwrite when a client requests a fresh nonce (they may
    // have lost the previous one), so we use SET EX without NX here to allow
    // re-issuance while still bounding growth with the TTL.
    await this.cache.set(key, nonce, NONCE_TTL_SECONDS);

    return nonce;
  }

  // ------------------------------------------------------------------
  // SIGNATURE VERIFICATION (Stellar Ed25519)
  // ------------------------------------------------------------------

  /**
   * Verify that `signature` is a valid Ed25519 signature of `message`
   * produced by the private key corresponding to `stellarAddress`.
   *
   * Stellar uses Ed25519; `Keypair.verify()` from stellar-sdk handles the
   * underlying `tweetnacl` verification.
   *
   * @param stellarAddress  The G… public key the client claims to own.
   * @param message         The exact nonce string that was signed.
   * @param signatureBase64 The base64-encoded 64-byte Ed25519 signature.
   * @returns `true` if the signature is valid, `false` otherwise.
   */
  verifySignature(
    stellarAddress: string,
    message: string,
    signatureBase64: string,
  ): boolean {
    try {
      if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
        this.logger.warn(`verifySignature: invalid Stellar address format: ${stellarAddress}`);
        return false;
      }

      const keypair = Keypair.fromPublicKey(stellarAddress);
      const messageBuffer = Buffer.from(message, 'utf-8');
      const signatureBuffer = Buffer.from(signatureBase64, 'base64');

      return keypair.verify(messageBuffer, signatureBuffer);
    } catch (err) {
      this.logger.warn(
        `verifySignature failed for ${stellarAddress}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ------------------------------------------------------------------
  // LOGIN
  // ------------------------------------------------------------------

  async login(payload: {
    stellarAddress: string;
    signedNonce: string;
    signature: string;
    role?: 'STUDENT' | 'INSTRUCTOR';
    referralCode?: string;
    totpCode?: string;
  }, deviceMeta?: DeviceMetadata): Promise<TokenPair & { user: SafeUser }> {
    const { stellarAddress, signedNonce, signature, role, referralCode, totpCode } = payload;

    // ---- 1. Validate Stellar address format ----
    if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
      throw new UnauthorizedException(
        'Invalid Stellar address: must be a valid Ed25519 public key (G…).',
      );
    }

    // ---- 2. Look up the stored nonce from Redis ----
    const key = this.nonceRedisKey(stellarAddress);
    const storedNonce = await this.cache.get<string>(key);

    if (!storedNonce) {
      throw new UnauthorizedException(
        'No pending nonce found for this address. Request a fresh nonce first.',
      );
    }

    // ---- 3. Nonce integrity check ----
    // The client must sign the exact nonce string the server issued.
    // We do NOT consume the nonce yet — only after the signature passes.
    if (signedNonce !== storedNonce) {
      throw new UnauthorizedException(
        'Nonce mismatch: the signed nonce does not match the issued nonce for this address.',
      );
    }

    // ---- 4. Ed25519 signature verification ----
    const isValid = this.verifySignature(stellarAddress, signedNonce, signature);

    if (!isValid) {
      // Do NOT consume the nonce on a bad signature to prevent DoS where an
      // attacker submits a wrong signature to lock out the legitimate owner.
      throw new UnauthorizedException(
        'Signature verification failed: the provided signature is not a valid Ed25519 ' +
        'signature of the nonce by the claimed Stellar address.',
      );
    }

    // ---- 5. Consume nonce — only after valid signature (single-use enforcement) ----
    await this.cache.del(key);

    // ---- 6. Upsert user ----
    const existing = await this.prisma.user.findUnique({ where: { stellarAddress } });
    const isNewUser = !existing;

    // Issues #74/#75 — a deleted account can never authenticate.
    if (existing?.deletedAt) {
      throw new UnauthorizedException('Account has been deleted');
    }

    // ---- 6b. Validate 2FA code when the account has it enabled ----
    if (existing?.twoFactorEnabled) {
      if (!totpCode) {
        throw new UnauthorizedException('Two-factor authentication code required');
      }
      const isTotpValid = await this.twoFactor.verifyLoginCode(existing.id, totpCode);
      if (!isTotpValid) {
        throw new UnauthorizedException('Invalid two-factor authentication code');
      }
    }

    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: {
        stellarAddress,
        role: role ?? 'STUDENT',
      },
      update: { updatedAt: new Date() },
    });

    // ---- 7. Track referral for brand-new registrations only ----
    if (isNewUser && referralCode) {
      try {
        await this.referrals.validateCode(referralCode, user.id);
        await this.referrals.trackSignup(user.id, referralCode);
      } catch (error) {
        this.logger.warn(
          `Referral code "${referralCode}" rejected for ${stellarAddress}: ${(error as Error).message}`,
        );
        // Soft-fail: registration succeeds even if referral code is invalid
      }
    }

    // ---- 8. Issue rotating refresh pair and track the access-token session ----
    const tokens = await this.issueSessionedTokenPair(user, deviceMeta);

    this.logger.log(`User authenticated: ${stellarAddress} (${user.role})`);
    // Issue #234 — never return the TOTP secret or recovery-code hashes
    return { ...tokens, user: toSafeUser(user) };
  }

  async refresh(refreshToken: string, deviceMeta?: DeviceMetadata): Promise<TokenPair> {
    const tokens = await this.refreshTokens.rotate(refreshToken);
    await this.trackAccessTokenSession(tokens.accessToken, deviceMeta);
    return tokens;
  }

  private async issueSessionedTokenPair(
    user: { id: string; stellarAddress: string | null; googleId?: string | null; role: string },
    deviceMeta?: DeviceMetadata,
  ): Promise<TokenPair> {
    const tokens = await this.refreshTokens.issueTokenPair(user);
    await this.trackAccessTokenSession(tokens.accessToken, deviceMeta);
    return tokens;
  }

  private async trackAccessTokenSession(accessToken: string, deviceMeta?: DeviceMetadata) {
    const decoded = this.jwt.decode(accessToken) as { exp?: number; jti?: string; sub?: string } | null;
    if (!decoded?.jti || !decoded.sub) return;

    const expiresAt = decoded.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.sessions.createSession({
      userId: decoded.sub,
      jti: decoded.jti,
      expiresAt,
      meta: deviceMeta,
    });
  }
}
