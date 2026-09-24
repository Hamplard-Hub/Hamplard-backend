import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StartImpersonationDto } from './dto/start-impersonation.dto';
import { v4 as uuidv4 } from 'uuid';
import { AuditAction, AuditTargetType, ImpersonationSessionStatus } from '@prisma/client';

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async startImpersonation(adminId: string, dto: StartImpersonationDto) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== 'ADMIN') {
      throw new ForbiddenException('Only admin users can start an impersonation session');
    }

    const targetUser = await this.prisma.user.findUnique({ where: { id: dto.targetUserId } });
    if (!targetUser) {
      throw new NotFoundException(`Target user with ID ${dto.targetUserId} not found`);
    }

    const durationSeconds = dto.durationSeconds ?? 3600;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
    const sessionId = uuidv4();

    const accessToken = this.jwtService.sign(
      {
        sub: targetUser.id,
        stellarAddress: targetUser.stellarAddress,
        role: targetUser.role,
        isImpersonating: true,
        impersonatorId: adminId,
        sessionId,
      },
      { expiresIn: `${durationSeconds}s` },
    );

    const session = await this.prisma.impersonationSession.create({
      data: {
        sessionId,
        adminId,
        targetUserId: targetUser.id,
        reason: dto.reason,
        durationSeconds,
        startedAt: now,
        expiresAt,
        status: ImpersonationSessionStatus.ACTIVE,
      },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.IMPERSONATION_STARTED,
        targetType: AuditTargetType.USER,
        targetId: targetUser.id,
        metadata: {
          sessionId,
          targetUserEmail: targetUser.email,
          targetUserName: targetUser.name,
          reason: dto.reason,
          durationSeconds,
        },
      },
    });

    this.logger.log(`Admin ${adminId} started impersonating user ${targetUser.id} for ${durationSeconds}s (Session: ${sessionId})`);

    return {
      sessionId,
      accessToken,
      targetUser: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
      },
      durationSeconds,
      startedAt: now,
      expiresAt,
    };
  }

  async getAuditTrail(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.impersonationSession.findMany({
        skip,
        take: limit,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.impersonationSession.count(),
    ]);

    return { data, total, page, limit };
  }

  async getActiveSessions() {
    const now = new Date();
    return this.prisma.impersonationSession.findMany({
      where: {
        status: ImpersonationSessionStatus.ACTIVE,
        expiresAt: { gt: now },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  async verifySession(sessionId: string) {
    const session = await this.prisma.impersonationSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      throw new NotFoundException('Impersonation session not found');
    }

    const now = new Date();
    let currentStatus = session.status;

    if (currentStatus === ImpersonationSessionStatus.ACTIVE && now > session.expiresAt) {
      currentStatus = ImpersonationSessionStatus.EXPIRED;
      await this.prisma.impersonationSession.update({
        where: { sessionId },
        data: { status: ImpersonationSessionStatus.EXPIRED },
      });
    }

    return {
      sessionId: session.sessionId,
      adminId: session.adminId,
      targetUserId: session.targetUserId,
      status: currentStatus,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      isActive: currentStatus === ImpersonationSessionStatus.ACTIVE,
    };
  }

  async endSession(sessionId: string, adminId: string, force: boolean = false) {
    const session = await this.prisma.impersonationSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      throw new NotFoundException('Impersonation session not found');
    }

    if (!force && session.adminId !== adminId) {
      throw new ForbiddenException('Cannot end an impersonation session created by another admin');
    }

    const now = new Date();
    const isForceEnd = force && session.adminId !== adminId;

    await this.prisma.impersonationSession.update({
      where: { sessionId },
      data: {
        status: isForceEnd ? ImpersonationSessionStatus.FORCE_ENDED : ImpersonationSessionStatus.ENDED,
        endedAt: now,
        endedBy: adminId,
        forceEndedBy: isForceEnd ? adminId : null,
      },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.IMPERSONATION_ENDED,
        targetType: AuditTargetType.USER,
        targetId: session.targetUserId,
        metadata: {
          sessionId,
          originalAdminId: session.adminId,
          forceEnded: isForceEnd,
          reason: isForceEnd ? 'Force-ended by admin' : 'Session ended by originating admin',
        },
      },
    });

    this.logger.log(`Impersonation session ${sessionId} ${isForceEnd ? 'force-' : ''}ended by admin ${adminId}`);

    return { sessionId, status: isForceEnd ? 'FORCE_ENDED' : 'ENDED', endedAt: now };
  }
}