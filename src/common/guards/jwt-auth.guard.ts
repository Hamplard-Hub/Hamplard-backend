import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private readonly prisma: PrismaService) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const canActivate = await super.canActivate(context);
        if (!canActivate) {
            return false;
        }

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || !user.id) {
            throw new UnauthorizedException('Invalid token payload');
        }

        const userRecord = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                isBanned: true,
                banReason: true,
                isSuspended: true,
                suspendedUntil: true,
                suspensionReason: true,
            },
        });

        if (!userRecord) {
            throw new UnauthorizedException('User not found');
        }

        if (userRecord.isBanned) {
            throw new UnauthorizedException(
                `Account is permanently banned. Reason: ${userRecord.banReason || 'Violation of terms'}`,
            );
        }

        if (userRecord.isSuspended) {
            if (userRecord.suspendedUntil && userRecord.suspendedUntil <= new Date()) {
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        isSuspended: false,
                        suspendedAt: null,
                        suspendedUntil: null,
                        suspensionReason: null,
                    },
                });
            } else {
                const untilDate = userRecord.suspendedUntil
                    ? userRecord.suspendedUntil.toISOString()
                    : 'indefinitely';
                throw new UnauthorizedException(
                    `Account is suspended until ${untilDate}. Reason: ${userRecord.suspensionReason || 'Under review'}`,
                );
            }
        }

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

        if (user.isImpersonating && user.sessionId) {
            const impersonationSession = await this.prisma.impersonationSession.findUnique({
                where: { sessionId: user.sessionId },
                select: { status: true, expiresAt: true },
            });

            if (!impersonationSession) {
                throw new UnauthorizedException('Impersonation session not found');
            }

            if (impersonationSession.status !== 'ACTIVE') {
                throw new UnauthorizedException('Impersonation session is no longer active');
            }

            if (impersonationSession.expiresAt <= new Date()) {
                throw new UnauthorizedException('Impersonation session has expired');
            }
        }

        return true;
    }
}