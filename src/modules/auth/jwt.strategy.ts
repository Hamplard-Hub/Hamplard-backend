import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthUserCacheService } from '../../common/auth-user/auth-user-cache.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    // Issue #433 — the throttle guard shares this cached lookup so a role
    // change is reflected in both authentication and the rate-limit bucket.
    private readonly users: AuthUserCacheService,
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

    const user = await this.users.getUser(userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // Issues #74/#75 — deleted accounts are dead; suspended/banned ones are
    // rejected here. The guard uses the same assertion for its bucket.
    this.users.assertActive(user);

    // Issues #69/#418 — session revocation/expiry is enforced here so it is
    // shared by every guard built on the 'jwt' strategy. JwtAuthGuard rejects
    // the request; OptionalJwtAuthGuard turns a revoked/expired token into an
    // anonymous caller (its handleRequest swallows the error). Tokens issued
    // before session tracking carry no `jti` and are let through; a `jti` with
    // no matching session row is also let through.
    const jti = payload.jti;
    if (jti) {
      const session = await this.prisma.session.findUnique({
        where: { jti },
        select: { revokedAt: true, expiresAt: true },
      });

      if (session) {
        if (session.revokedAt) {
          throw new UnauthorizedException('Session has been revoked');
        }
        if (session.expiresAt <= new Date()) {
          throw new UnauthorizedException('Session has expired');
        }

        this.prisma.session
          .update({ where: { jti }, data: { lastActiveAt: new Date() } })
          .catch(() => undefined);
      }
    }

    return {
      id: user.id,
      stellarAddress: user.stellarAddress || payload.stellarAddress,
      googleId: user.googleId || payload.googleId,
      role: user.role,
      isBanned: user.isBanned,
      isSuspended: user.isSuspended,
      isDeactivated: Boolean(user.deactivatedAt),
      jti,
    };
  }
}
