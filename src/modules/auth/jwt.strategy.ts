import { Injectable, UnauthorizedException, ForbiddenException, Optional } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';

interface UserCacheEntry {
  id: string;
  stellarAddress: string | null;
  googleId: string | null;
  role: string;
  isBanned: boolean;
  isSuspended: boolean;
  suspendedUntil: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly inMemoryCache = new Map<string, { data: UserCacheEntry; expiresAt: number }>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly cacheService?: CacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    if (payload?.typ === 'refresh') {
      throw new UnauthorizedException('Refresh token cannot be used as an access token');
    }

    const userId = payload.sub;
    if (!userId) {
      throw new UnauthorizedException('Invalid token payload');
    }

    let user: UserCacheEntry | null = null;
    const cacheKey = `jwt:user:${userId}`;

    if (this.cacheService) {
      user = await this.cacheService.get<UserCacheEntry>(cacheKey);
    } else {
      const cached = this.inMemoryCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        user = cached.data;
      }
    }

    if (!user) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          stellarAddress: true,
          googleId: true,
          role: true,
          isBanned: true,
          isSuspended: true,
          suspendedUntil: true,
        },
      });

      if (!dbUser) {
        throw new UnauthorizedException('User no longer exists');
      }

      user = {
        id: dbUser.id,
        stellarAddress: dbUser.stellarAddress,
        googleId: dbUser.googleId,
        role: dbUser.role,
        isBanned: dbUser.isBanned,
        isSuspended: dbUser.isSuspended,
        suspendedUntil: dbUser.suspendedUntil ? dbUser.suspendedUntil.toISOString() : null,
      };

      if (this.cacheService) {
        await this.cacheService.set(cacheKey, user, 30);
      } else {
        this.inMemoryCache.set(userId, {
          data: user,
          expiresAt: Date.now() + 30000,
        });
      }
    }

    if (user.isBanned) {
      throw new ForbiddenException('User is banned');
    }

    if (user.isSuspended) {
      const suspendedUntil = user.suspendedUntil ? new Date(user.suspendedUntil) : null;
      if (!suspendedUntil || suspendedUntil > new Date()) {
        throw new ForbiddenException('User is suspended');
      }
    }

    return {
      id: user.id,
      stellarAddress: user.stellarAddress || payload.stellarAddress,
      googleId: user.googleId || payload.googleId,
      role: user.role,
      isBanned: user.isBanned,
      isSuspended: user.isSuspended,
      jti: payload.jti,
    };
  }
}

