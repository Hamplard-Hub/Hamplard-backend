import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseDurationMs(value: string, fallbackMs: number): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return fallbackMs;
  return Number(match[1]) * DURATION_UNITS[match[2]];
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenUser {
  id: string;
  stellarAddress: string | null;
  googleId?: string | null;
  role: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface RefreshTokenPayload {
  sub: string;
  familyId: string;
  generation: number;
  typ: 'refresh';
  jti: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly refreshSecret: string;
  private readonly refreshExpiresIn: string;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.refreshSecret =
      config.get<string>('JWT_REFRESH_SECRET') || config.get<string>('JWT_SECRET');
    this.refreshExpiresIn = config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d');
    this.refreshTtlMs = parseDurationMs(this.refreshExpiresIn, 30 * 24 * 60 * 60 * 1000);
  }

  async issueTokenPair(
    user: TokenUser,
    familyId?: string,
    generation = 1,
  ): Promise<TokenPair> {
    const family = familyId ?? randomUUID();
    const tokenId = randomUUID();
    const accessToken = this.jwt.sign({
      sub: user.id,
      stellarAddress: user.stellarAddress,
      googleId: user.googleId,
      role: user.role,
    });
    const refreshToken = this.jwt.sign(
      {
        sub: user.id,
        familyId: family,
        generation,
        typ: 'refresh',
        jti: tokenId,
      } satisfies RefreshTokenPayload,
      { secret: this.refreshSecret, expiresIn: this.refreshExpiresIn },
    );

    await this.prisma.refreshToken.create({
      data: {
        id: tokenId,
        userId: user.id,
        familyId: family,
        generation,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
      },
    });

    this.logger.log(
      `Issued refresh token for user ${user.id} (family ${family}, generation ${generation})`,
    );

    return { accessToken, refreshToken };
  }

  async rotate(rawRefreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (record?.consumedAt) {
      await this.revokeFamily(record.familyId);
      this.logger.warn(`Refresh token reuse detected for family ${record.familyId}`);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (record?.revokedAt) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const payload = this.verifyRefreshToken(rawRefreshToken);

    if (!record) {
      await this.revokeFamily(payload.familyId);
      this.logger.warn(
        `Unknown refresh token presented for family ${payload.familyId}; family revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (
      payload.familyId !== record.familyId ||
      payload.sub !== record.userId ||
      payload.generation !== record.generation
    ) {
      await this.revokeFamily(record.familyId);
      this.logger.warn(`Refresh token mismatch for family ${record.familyId}; family revoked`);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const consumed = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });

    if (consumed.count !== 1) {
      await this.revokeFamily(record.familyId);
      this.logger.warn(`Refresh token reuse detected for family ${record.familyId}`);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return this.issueTokenPair(user, record.familyId, record.generation + 1);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private verifyRefreshToken(token: string): RefreshTokenPayload {
    let payload: Partial<RefreshTokenPayload>;
    try {
      payload = this.jwt.verify(token, { secret: this.refreshSecret });
    } catch (error) {
      if (error?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Refresh token expired');
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (
      payload?.typ !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      typeof payload.familyId !== 'string' ||
      typeof payload.generation !== 'number' ||
      typeof payload.jti !== 'string'
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return payload as RefreshTokenPayload;
  }
}
