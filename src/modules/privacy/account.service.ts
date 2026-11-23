// account.service.ts
// Issues #74 / #75 — account deactivation, reactivation and GDPR deletion.
//
// Deletion is anonymisation: the user row is kept (financial and audit records
// reference it and must be retained) but every piece of personal data is
// removed or replaced. Everything runs in a single transaction so a failure
// can never leave a half-anonymised account; re-running on a failed attempt is safe.
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditTargetType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';

const REDACTED = '[deleted]';

/** Keys that may carry personal data inside AdminAuditLog.metadata. */
const AUDIT_PII_KEYS = ['stellarAddress', 'email', 'name', 'phoneNumber', 'ipAddress'];

export function deletedWalletPlaceholder(userId: string): string {
  return `deleted:${userId}`;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ----------------------------------------------------------
  // DEACTIVATE / REACTIVATE
  // ----------------------------------------------------------

  async deactivate(userId: string) {
    const user = await this.requireLiveUser(userId);
    if (user.deactivatedAt) {
      throw new BadRequestException('Account is already deactivated');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deactivatedAt: now } });
      await this.revokeCredentials(tx, userId, now);
    });
    await this.invalidateAuthCache(userId);

    this.logger.log(`Account deactivated: user=${userId}`);
    return { deactivated: true, deactivatedAt: now };
  }

  async reactivate(userId: string) {
    const user = await this.requireLiveUser(userId);
    if (!user.deactivatedAt) {
      throw new BadRequestException('Account is not deactivated');
    }

    await this.prisma.user.update({ where: { id: userId }, data: { deactivatedAt: null } });
    await this.invalidateAuthCache(userId);

    this.logger.log(`Account reactivated: user=${userId}`);
    return { reactivated: true };
  }

  // ----------------------------------------------------------
  // DELETE (ANONYMISE)
  // ----------------------------------------------------------

  async deleteAccount(userId: string) {
    const user = await this.requireLiveUser(userId);
    const now = new Date();
    const oldAddress = user.stellarAddress;
    const placeholder = deletedWalletPlaceholder(userId);

    await this.prisma.$transaction(async (tx) => {
      // 1. Kill every way back in.
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.phoneOtp.deleteMany({ where: { userId } });

      // 2. Delete records that exist only to serve this person.
      await tx.notificationDeviceToken.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      await tx.notificationDigestPreference.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.wishlistItem.deleteMany({ where: { studentId: userId } });
      await tx.courseDraft.deleteMany({ where: { instructorId: userId } });
      await tx.dataExportJob.deleteMany({ where: { userId } });
      await tx.smsMessage.deleteMany({ where: { userId } });
      await tx.liveSessionRsvp.deleteMany({ where: { studentId: userId } });
      await tx.payoutSchedule.deleteMany({ where: { instructorId: userId } });

      // 3. Scrub free text / identifiers on records that must otherwise stay.
      await tx.assignmentSubmission.updateMany({
        where: { studentId: userId },
        data: { notes: null, submissionUrl: null, feedback: null },
      });
      await tx.courseReview.updateMany({ where: { studentId: userId }, data: { comment: null } });
      await tx.question.updateMany({
        where: { authorId: userId },
        data: { title: REDACTED, content: REDACTED },
      });
      await tx.answer.updateMany({ where: { authorId: userId }, data: { content: REDACTED } });
      await tx.discussionComment.updateMany({
        where: { authorId: userId },
        data: { content: REDACTED },
      });
      await tx.abuseReport.updateMany({ where: { reporterId: userId }, data: { description: null } });
      await tx.kycSubmission.updateMany({
        where: { instructorId: userId },
        data: { documentUrl: REDACTED, additionalUrl: null, adminNotes: null },
      });
      await tx.certificate.updateMany({ where: { studentId: userId }, data: { pdfUrl: null } });
      await tx.dispute.updateMany({ where: { filedById: userId }, data: { description: REDACTED } });
      await tx.refund.updateMany({ where: { studentId: userId }, data: { reason: REDACTED } });
      await tx.analyticsEvent.updateMany({
        where: { userId },
        data: {
          userId: null,
          sessionId: null,
          ipAddress: null,
          userAgent: null,
          properties: Prisma.DbNull,
        },
      });

      // 4. Financial records stay (amounts, txHash, invoice numbers) — only the
      //    free-text note and the link to the deleted payout destination go.
      await tx.payout.updateMany({
        where: { instructorId: userId },
        data: { notes: null, scheduleId: null },
      });

      // 5. Wallet copies that are not foreign keys.
      if (oldAddress) {
        await tx.liveSession.updateMany({
          where: { instructorAddress: oldAddress },
          data: { instructorAddress: placeholder },
        });
        await tx.certificate.updateMany({
          where: { instructorAddress: oldAddress },
          data: { instructorAddress: placeholder },
        });
      }

      // 6. Audit trail is retained, minus personal data.
      await this.scrubAuditLogs(tx, userId);

      // 7. The user row itself. The wallet becomes a unique placeholder (this
      //    cascades to courses.instructorAddress / bundles.instructorAddress via
      //    their ON UPDATE CASCADE foreign keys) so the real address is freed.
      await tx.user.update({
        where: { id: userId },
        data: {
          stellarAddress: placeholder,
          googleId: null,
          email: null,
          name: null,
          bio: null,
          avatarUrl: null,
          phoneNumber: null,
          phoneCountryCode: null,
          isPhoneVerified: false,
          phoneVerifiedAt: null,
          isVerified: false,
          banReason: null,
          suspensionReason: null,
          twoFactorSecret: null,
          twoFactorEnabled: false,
          twoFactorEnabledAt: null,
          twoFactorRecoveryCodes: [],
          deactivatedAt: null,
          deletedAt: now,
        },
      });
    });

    await this.invalidateAuthCache(userId);
    this.logger.log(`Account deleted and anonymised: user=${userId}`);
    return { deleted: true, deletedAt: now };
  }

  // ----------------------------------------------------------
  // INTERNALS
  // ----------------------------------------------------------

  private async requireLiveUser(userId: string) {
    if (!userId) {
      throw new BadRequestException('Authenticated user id is required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, stellarAddress: true, deactivatedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private async revokeCredentials(tx: Prisma.TransactionClient, userId: string, at: Date) {
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  private async scrubAuditLogs(tx: Prisma.TransactionClient, userId: string) {
    const where: Prisma.AdminAuditLogWhereInput = {
      OR: [{ actorId: userId }, { targetType: AuditTargetType.USER, targetId: userId }],
    };
    await tx.adminAuditLog.updateMany({ where, data: { ipAddress: null } });

    const logs = await tx.adminAuditLog.findMany({ where, select: { id: true, metadata: true } });
    for (const log of logs) {
      const meta = log.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      const cleaned = Object.fromEntries(
        Object.entries(meta as Record<string, Prisma.JsonValue>).filter(
          ([key]) => !AUDIT_PII_KEYS.includes(key),
        ),
      ) as Prisma.InputJsonObject;
      if (Object.keys(cleaned).length !== Object.keys(meta).length) {
        await tx.adminAuditLog.update({ where: { id: log.id }, data: { metadata: cleaned } });
      }
    }
  }

  /** Drop the 30s JwtStrategy user cache so the new state applies immediately. */
  private async invalidateAuthCache(userId: string) {
    await this.cache.del(`jwt:user:${userId}`);
  }
}
