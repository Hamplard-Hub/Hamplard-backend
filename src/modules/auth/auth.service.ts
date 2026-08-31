// auth.service.ts
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { SessionsService, DeviceMetadata } from './sessions.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * How many milliseconds of clock-skew between client and server we tolerate
 * when evaluating nonce expiry. Set to 30 seconds.
 */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

/**
 * How long (ms) a nonce is valid for after issuance (5 minutes).
 */
const NONCE_TTL_MS = 5 * 60 * 1000;

interface StoredNonce {
  nonce: string;
  /** Wall-clock timestamp (ms) when this nonce was issued. */
  issuedAt: number;
  /** Wall-clock timestamp (ms) when this nonce expires (issuedAt + NONCE_TTL_MS). */
  expiresAt: number;
  /** Whether this nonce has already been consumed — guards against replay. */
  consumed: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly nonces = new Map<string, StoredNonce>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly referrals: ReferralsService,
    private readonly sessions: SessionsService,
  ) {}

  // ------------------------------------------------------------------
  // NONCE GENERATION
  // ------------------------------------------------------------------

  /**
   * Issue a fresh single-use nonce tied to the given Stellar address.
   * The nonce is valid for NONCE_TTL_MS (5 minutes).
   * Calling this again for the same address invalidates any previous nonce.
   */
  generateNonce(stellarAddress: string): string {
    const now = Date.now();
    const nonce = `hamplard:${stellarAddress}:${now}:${Math.random().toString(36).slice(2)}`;

    this.nonces.set(stellarAddress, {
      nonce,
      issuedAt: now,
      expiresAt: now + NONCE_TTL_MS,
      consumed: false,
    });

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
  }, deviceMeta?: DeviceMetadata): Promise<{ accessToken: string; user: any }> {
    const { stellarAddress, signedNonce, signature, role, referralCode } = payload;

    // ---- 1. Validate Stellar address format ----
    if (!StrKey.isValidEd25519PublicKey(stellarAddress)) {
      throw new UnauthorizedException(
        'Invalid Stellar address: must be a valid Ed25519 public key (G…).',
      );
    }

    // ---- 2. Look up the stored nonce ----
    const stored = this.nonces.get(stellarAddress);

    if (!stored) {
      throw new UnauthorizedException(
        'No pending nonce found for this address. Request a fresh nonce first.',
      );
    }

    // ---- 3. Single-use check — reject replays ----
    if (stored.consumed) {
      throw new UnauthorizedException(
        'Nonce has already been used. Request a new nonce to authenticate again.',
      );
    }

    // ---- 4. Clock-skew tolerant expiry check ----
    const now = Date.now();
    if (now > stored.expiresAt + CLOCK_SKEW_TOLERANCE_MS) {
      // Nonce is definitively expired — evict it and reject
      this.nonces.delete(stellarAddress);
      throw new UnauthorizedException(
        'Nonce has expired. Please request a new nonce and sign it within 5 minutes.',
      );
    }

    // ---- 5. Nonce integrity check ----
    // The client must sign the exact nonce string the server issued.
    if (signedNonce !== stored.nonce) {
      // Mark consumed to prevent brute-force iteration without explicitly leaking the expected value
      stored.consumed = true;
      throw new UnauthorizedException(
        'Nonce mismatch: the signed nonce does not match the issued nonce for this address.',
      );
    }

    // ---- 6. Ed25519 signature verification ----
    const isValid = this.verifySignature(stellarAddress, signedNonce, signature);

    if (!isValid) {
      // Mark consumed to prevent repeated guessing on the same nonce
      stored.consumed = true;
      throw new UnauthorizedException(
        'Signature verification failed: the provided signature is not a valid Ed25519 ' +
        'signature of the nonce by the claimed Stellar address.',
      );
    }

    // ---- 7. Consume nonce (single-use enforcement) ----
    stored.consumed = true;
    this.nonces.delete(stellarAddress);

    // ---- 8. Upsert user ----
    const existing = await this.prisma.user.findUnique({ where: { stellarAddress } });
    const isNewUser = !existing;

    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: {
        stellarAddress,
        role: role ?? 'STUDENT',
      },
      update: { updatedAt: new Date() },
    });

    // ---- 9. Track referral for brand-new registrations only ----
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

    // ---- 10. Issue JWT (with a session-tracking jti — issue #69) ----
    const jti = uuidv4();
    const accessToken = this.jwt.sign({
      sub:            user.id,
      stellarAddress: user.stellarAddress,
      role:           user.role,
      jti,
    });

    const decoded = this.jwt.decode(accessToken) as { exp?: number };
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.sessions.createSession({ userId: user.id, jti, expiresAt, meta: deviceMeta });

    this.logger.log(`User authenticated: ${stellarAddress} (${user.role})`);
    return { accessToken, user };
  }
}
