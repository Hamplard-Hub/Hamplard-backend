// Shared, cached lookup of the live user record used by JwtStrategy and by
// RoleThrottlerGuard (issues #433). Both consumers must see the same role and
// account state so that the throttle bucket can never outlive a demotion or ban.
import {
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

export interface AuthUser {
  id: string;
  stellarAddress: string | null;
  googleId: string | null;
  role: string;
  isBanned: boolean;
  isSuspended: boolean;
  suspendedUntil: string | null;
  deactivatedAt: string | null;
  deletedAt: string | null;
}

const CACHE_KEY_PREFIX = 'jwt:user:';
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class AuthUserCacheService {
  private readonly inMemoryCache = new Map<string, { data: AuthUser; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cacheService?: CacheService,
  ) {}

  /** Returns the current user record from the shared cache (or the DB on a miss). */
  async getUser(userId: string): Promise<AuthUser | null> {
    if (!userId) return null;

    const cacheKey = `${CACHE_KEY_PREFIX}${userId}`;
    let user: AuthUser | null = null;

    if (this.cacheService) {
      user = await this.cacheService.get<AuthUser>(cacheKey);
    } else {
      const cached = this.inMemoryCache.get(userId);
      if (cached && cached.expiresAt > Date.now()) {
        user = cached.data;
      }
    }

    if (user) return user;

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
        deactivatedAt: true,
        deletedAt: true,
      },
    });

    if (!dbUser) return null;

    user = {
      id: dbUser.id,
      stellarAddress: dbUser.stellarAddress,
      googleId: dbUser.googleId,
      role: dbUser.role,
      isBanned: dbUser.isBanned,
      isSuspended: dbUser.isSuspended,
      suspendedUntil: dbUser.suspendedUntil ? dbUser.suspendedUntil.toISOString() : null,
      deactivatedAt: dbUser.deactivatedAt ? dbUser.deactivatedAt.toISOString() : null,
      deletedAt: dbUser.deletedAt ? dbUser.deletedAt.toISOString() : null,
    };

    if (this.cacheService) {
      await this.cacheService.set(cacheKey, user, CACHE_TTL_SECONDS);
    } else {
      this.inMemoryCache.set(userId, {
        data: user,
        expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
      });
    }

    return user;
  }

  /** Single source of truth for account lifecycle checks on an auth lookup. */
  assertActive(user: AuthUser): void {
    if (user.deletedAt) {
      throw new UnauthorizedException('Account has been deleted');
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
  }
}
