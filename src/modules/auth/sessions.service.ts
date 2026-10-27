// sessions.service.ts — issue #69 & #501: session and device management + new-device login alerts
import { Injectable, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface DeviceMetadata {
  userAgent?: string;
  ipAddress?: string;
}

/** Very small heuristic parser — good enough for a human-readable device label. */
export function parseDeviceLabel(userAgent?: string): string | undefined {
  if (!userAgent) return undefined;

  let browser = 'Unknown browser';
  if (/edg\//i.test(userAgent)) browser = 'Edge';
  else if (/chrome\//i.test(userAgent) && !/chromium/i.test(userAgent)) browser = 'Chrome';
  else if (/firefox\//i.test(userAgent)) browser = 'Firefox';
  else if (/safari\//i.test(userAgent) && !/chrome\//i.test(userAgent)) browser = 'Safari';
  else if (/opr\//i.test(userAgent)) browser = 'Opera';

  let os = 'Unknown OS';
  if (/windows/i.test(userAgent)) os = 'Windows';
  else if (/iphone|ipad|ios/i.test(userAgent)) os = 'iOS';
  else if (/android/i.test(userAgent)) os = 'Android';
  else if (/mac os/i.test(userAgent)) os = 'macOS';
  else if (/linux/i.test(userAgent)) os = 'Linux';

  return `${browser} on ${os}`;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async createSession(params: {
    userId: string;
    jti: string;
    expiresAt: Date;
    meta?: DeviceMetadata;
  }) {
    const { userId, jti, expiresAt, meta } = params;
    const deviceLabel = parseDeviceLabel(meta?.userAgent);
    const ipAddress = meta?.ipAddress;
    const hasDeviceContext = Boolean(deviceLabel || ipAddress || meta?.userAgent);

    const existingDeviceSession =
      hasDeviceContext && typeof this.prisma.session.findFirst === 'function'
        ? await this.prisma.session.findFirst({
            where: {
              userId,
              deviceLabel: deviceLabel ?? null,
              ipAddress: ipAddress ?? null,
            },
          })
        : null;

    const session = await this.prisma.session.create({
      data: {
        userId,
        jti,
        expiresAt,
        userAgent: meta?.userAgent,
        ipAddress,
        deviceLabel,
      },
    });

    if (hasDeviceContext && !existingDeviceSession && this.notifications) {
      const frontendUrl =
        this.config?.get<string>('FRONTEND_URL', 'https://hamplard.com') ??
        'https://hamplard.com';
      const sessionsUrl = `${frontendUrl.replace(/\/+$/, '')}/dashboard/settings/sessions`;
      const deviceSummary = deviceLabel ?? 'an unrecognized device';
      const ipSummary = ipAddress ? ` (IP: ${ipAddress})` : '';

      await this.notifications.notifyUser(
        userId,
        'NEW_DEVICE_LOGIN' as NotificationType,
        'New device sign-in detected',
        `We detected a sign-in to your Hamplard account from ${deviceSummary}${ipSummary}. Review or revoke active sessions at ${sessionsUrl}`,
        {
          sessionId: session.id,
          deviceLabel: deviceLabel ?? null,
          ipAddress: ipAddress ?? null,
          sessionsUrl,
        },
      );
    }

    return session;
  }

  /** Used by JwtAuthGuard to reject requests carrying a revoked/expired session token. */
  async isSessionActive(jti: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({ where: { jti } });
    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.expiresAt <= new Date()) return false;
    return true;
  }

  async touchLastActive(jti: string): Promise<void> {
    await this.prisma.session
      .updateMany({ where: { jti, revokedAt: null }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);
  }

  async listSessions(userId: string, currentJti?: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastActiveAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      expiresAt: s.expiresAt,
      isCurrent: Boolean(currentJti) && s.jti === currentJti,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) {
      throw new ForbiddenException('You do not own this session');
    }
    if (session.revokedAt) {
      return { id: session.id, revoked: true, revokedAt: session.revokedAt };
    }

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    return { id: updated.id, revoked: true, revokedAt: updated.revokedAt };
  }

  async revokeAllExceptCurrent(userId: string, currentJti?: string) {
    const where: any = { userId, revokedAt: null };
    if (currentJti) where.jti = { not: currentJti };

    const result = await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date() },
    });

    return { revoked: true, revokedCount: result.count };
  }
}
