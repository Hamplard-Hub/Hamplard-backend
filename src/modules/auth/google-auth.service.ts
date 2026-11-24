import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { SessionsService, DeviceMetadata } from './sessions.service';
import { toSafeUser } from '../users/user-serializer';
import { CacheService } from '../../common/cache/cache.service';
import { TwoFactorService } from './two-factor.service';
import { issueSessionedTokenPair } from './sessioned-token';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

/** TTL (seconds) for the one-time auth code handed to the frontend callback. */
const AUTH_CODE_TTL_SECONDS = 60;

/** TTL (seconds) for an OAuth state value stored in Redis. */
const OAUTH_STATE_TTL_SECONDS = 5 * 60;

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly googleClient?: OAuth2Client;
  private readonly clientId?: string;
  private readonly frontendUrl: string;
  readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly cache: CacheService,
    private readonly twoFactor: TwoFactorService,
    config: ConfigService,
  ) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID');
    this.enabled = Boolean(this.clientId && config.get<string>('GOOGLE_CLIENT_SECRET'));
    this.frontendUrl = config.get<string>('FRONTEND_URL', 'http://localhost:3001');

    if (!this.enabled) {
      this.logger.warn(
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google authentication is disabled',
      );
      return;
    }
    this.googleClient = new OAuth2Client(this.clientId);
  }

  /** Throws 503 when Google credentials are not configured. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException('Google authentication is not configured');
    }
  }

  // ------------------------------------------------------------------
  // OAuth state — stored in Redis for multi-instance safety
  // ------------------------------------------------------------------

  async createOAuthState(): Promise<string> {
    const state = randomBytes(32).toString('hex');
    await this.cache.set(`google:oauth:state:${state}`, '1', OAUTH_STATE_TTL_SECONDS);
    return state;
  }

  async consumeOAuthState(state: string): Promise<boolean> {
    const key = `google:oauth:state:${state}`;
    const exists = await this.cache.get<string>(key);
    if (!exists) return false;
    await this.cache.del(key);
    return true;
  }

  // ------------------------------------------------------------------
  // One-time auth code — issued at callback, exchanged by the frontend
  // ------------------------------------------------------------------

  /**
   * Store a short-lived one-time code that carries the full token pair.
   * The frontend exchanges this code for tokens via a dedicated endpoint.
   */
  async createAuthCode(tokens: object): Promise<string> {
    const code = randomBytes(32).toString('hex');
    await this.cache.set(`google:auth:code:${code}`, tokens, AUTH_CODE_TTL_SECONDS);
    return code;
  }

  async consumeAuthCode(code: string): Promise<object | null> {
    const key = `google:auth:code:${code}`;
    const tokens = await this.cache.get<object>(key);
    if (!tokens) return null;
    await this.cache.del(key);
    return tokens;
  }

  /** Returns the FRONTEND_URL to redirect to after a successful OAuth callback. */
  getFrontendCallbackUrl(code: string): string {
    return `${this.frontendUrl}/auth/google/callback?code=${code}`;
  }

  // ------------------------------------------------------------------
  // Token verification
  // ------------------------------------------------------------------

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    this.assertEnabled();

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleClient!.verifyIdToken({ idToken, audience: this.clientId });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const validIssuer = payload?.iss === 'accounts.google.com' || payload?.iss === 'https://accounts.google.com';
    if (!payload?.sub || !payload.email || !payload.email_verified || !validIssuer) {
      throw new UnauthorizedException('Invalid Google identity');
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified,
      name: payload.name,
      avatarUrl: payload.picture,
    };
  }

  async loginWithIdToken(idToken: string, deviceMeta?: DeviceMetadata) {
    return this.login(await this.verifyIdToken(idToken), deviceMeta);
  }

  // ------------------------------------------------------------------
  // Login / account linking
  // ------------------------------------------------------------------

  async login(identity: GoogleIdentity, deviceMeta?: DeviceMetadata) {
    if (!identity.emailVerified) {
      throw new UnauthorizedException('A verified Google email is required');
    }

    const existingByGoogle = await this.prisma.user.findUnique({
      where: { googleId: identity.googleId },
    });

    // When no account is linked to this Google ID yet, look up by e-mail.
    // Only auto-link when the existing account's email has been verified by
    // us — otherwise an attacker who sets a victim's e-mail on their own
    // account can pre-hijack it before the victim signs in with Google.
    let existingByEmail = null;
    if (!existingByGoogle) {
      const candidate = await this.prisma.user.findUnique({
        where: { email: identity.email },
      });
      // isVerified is the platform-level email-verification flag.
      if (candidate?.isVerified) {
        existingByEmail = candidate;
      }
      // If the candidate exists but is NOT verified we deliberately ignore it
      // to prevent pre-hijacking.
    }

    const existing = existingByGoogle ?? existingByEmail;

    // Issues #74/#75 — a deleted account can never authenticate.
    if (existing?.deletedAt) {
      throw new UnauthorizedException('Account has been deleted');
    }

    // ---- Enforce 2FA for Google logins on 2FA-enabled accounts ----
    if (existing?.twoFactorEnabled) {
      // We cannot interactively prompt for a TOTP here during the OAuth redirect
      // flow, so we reject with a clear error.  Clients using the ID-token
      // endpoint (/auth/google/token) should pass totpCode alongside idToken.
      // The controller layer must handle this case.
      throw new UnauthorizedException(
        'Two-factor authentication is enabled on this account. ' +
        'Please use the token endpoint and supply your TOTP code.',
      );
    }

    try {
      const user = existing
        ? await this.prisma.user.update({
            where: { id: existing.id },
            data: {
              googleId: identity.googleId,
              email: existing.email ?? identity.email,
              name: existing.name ?? identity.name,
              avatarUrl: existing.avatarUrl ?? identity.avatarUrl,
            },
          })
        : await this.prisma.user.create({
            data: {
              googleId: identity.googleId,
              email: identity.email,
              name: identity.name,
              avatarUrl: identity.avatarUrl,
              role: 'STUDENT',
            },
          });

      const tokens = await issueSessionedTokenPair(
        this.refreshTokens,
        this.jwt,
        this.sessions,
        user,
        deviceMeta,
      );

      // Issue #234 — never return the TOTP secret or recovery-code hashes
      return { ...tokens, user: toSafeUser(user) };
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new ConflictException('Google account is already linked to another user');
      }
      throw error;
    }
  }

  /**
   * Login with Google ID token + TOTP code for 2FA-enabled accounts.
   */
  async loginWithIdTokenAndTotp(
    idToken: string,
    totpCode: string,
    deviceMeta?: DeviceMetadata,
  ) {
    const identity = await this.verifyIdToken(idToken);

    if (!identity.emailVerified) {
      throw new UnauthorizedException('A verified Google email is required');
    }

    const existingByGoogle = await this.prisma.user.findUnique({
      where: { googleId: identity.googleId },
    });

    let existingByEmail = null;
    if (!existingByGoogle) {
      const candidate = await this.prisma.user.findUnique({
        where: { email: identity.email },
      });
      if (candidate?.isVerified) {
        existingByEmail = candidate;
      }
    }

    const existing = existingByGoogle ?? existingByEmail;

    // Issues #74/#75 — a deleted account can never authenticate.
    if (existing?.deletedAt) {
      throw new UnauthorizedException('Account has been deleted');
    }

    if (!existing?.twoFactorEnabled) {
      // Account does not have 2FA — fall through to the normal login path.
      return this.login(identity, deviceMeta);
    }

    // Verify TOTP before linking / issuing tokens.
    const isTotpValid = await this.twoFactor.verifyLoginCode(existing.id, totpCode);
    if (!isTotpValid) {
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }

    try {
      const user = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleId: identity.googleId,
          email: existing.email ?? identity.email,
          name: existing.name ?? identity.name,
          avatarUrl: existing.avatarUrl ?? identity.avatarUrl,
        },
      });

      const tokens = await issueSessionedTokenPair(
        this.refreshTokens,
        this.jwt,
        this.sessions,
        user,
        deviceMeta,
      );

      return { ...tokens, user: toSafeUser(user) };
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new ConflictException('Google account is already linked to another user');
      }
      throw error;
    }
  }
}
