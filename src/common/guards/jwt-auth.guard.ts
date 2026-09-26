import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private readonly prisma: PrismaService) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // First, validate the JWT token
        const canActivate = await super.canActivate(context);
        if (!canActivate) {
            return false;
        }

        // Get the request object
        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || !user.id) {
            throw new UnauthorizedException('Invalid token payload');
        }

        // Issue #69 — reject requests carrying a revoked/expired session token.
        // Tokens issued before session tracking existed carry no `jti` and are let through.
        if (user.jti) {
            const session = await this.prisma.session.findUnique({
                where: { jti: user.jti },
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
                    .update({ where: { jti: user.jti }, data: { lastActiveAt: new Date() } })
                    .catch(() => undefined);
            }
        }

        return true;
    }
}
