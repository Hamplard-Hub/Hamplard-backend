import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionsService, DeviceMetadata } from './sessions.service';
import { v4 as uuidv4 } from 'uuid';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly googleClient: OAuth2Client;
  private readonly clientId?: string;
  private readonly oauthStates = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
    config: ConfigService,
  ) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID');
    if (!this.clientId || !config.get<string>('GOOGLE_CLIENT_SECRET')) {
      throw new Error('Google authentication requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }
    this.googleClient = new OAuth2Client(this.clientId);
  }

  createOAuthState(): string {
    const state = randomBytes(32).toString('hex');
    this.oauthStates.set(state, Date.now() + 5 * 60 * 1000);
    return state;
  }

  consumeOAuthState(state: string): boolean {
    const expiresAt = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    return Boolean(expiresAt && Date.now() <= expiresAt);
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    if (!this.clientId) {
      throw new UnauthorizedException('Google authentication is not configured');
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience: this.clientId });
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

  async login(identity: GoogleIdentity, deviceMeta?: DeviceMetadata) {
    if (!identity.emailVerified) {
      throw new UnauthorizedException('A verified Google email is required');
    }

    const existingByGoogle = await this.prisma.user.findUnique({
      where: { googleId: identity.googleId },
    });
    const existingByEmail = existingByGoogle
      ? null
      : await this.prisma.user.findUnique({ where: { email: identity.email } });
    const existing = existingByGoogle ?? existingByEmail;

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

      const jti = uuidv4();
      const accessToken = this.jwt.sign({
        sub: user.id,
        stellarAddress: user.stellarAddress,
        googleId: user.googleId,
        role: user.role,
        jti,
      });

      const decoded = this.jwt.decode(accessToken) as { exp?: number };
      const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await this.sessions.createSession({ userId: user.id, jti, expiresAt, meta: deviceMeta });

      return { accessToken, user };
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new ConflictException('Google account is already linked to another user');
      }
      throw error;
    }
  }
}