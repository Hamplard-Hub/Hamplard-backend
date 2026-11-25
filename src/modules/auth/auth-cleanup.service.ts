import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CronMonitorService } from '../cron-monitor/cron-monitor.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_NAME = 'auth-record-purge';

@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cronMonitor: CronMonitorService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: JOB_NAME,
    timeZone: 'UTC',
  })
  async purgeExpiredRecords() {
    return this.cronMonitor.run(JOB_NAME, async () => {
      const raw = this.config.get<string | number>(
        'AUTH_RECORD_RETENTION_DAYS',
        30,
      );
      const retentionDays =
        typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
      if (
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        !Number.isFinite(cutoff.getTime())
      ) {
        throw new Error(
          'AUTH_RECORD_RETENTION_DAYS must be a positive integer number of days',
        );
      }

      // The transaction-scoped lock is shared by API instances and released
      // automatically on commit/rollback, including when a worker disconnects.
      const result = await this.prisma.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('hamplard:auth-record-purge')) AS acquired
        `;
          if (!lock.acquired) return null;

          const inactive = {
            OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
          };
          const sessions = await tx.session.deleteMany({ where: inactive });
          const refreshTokens = await tx.refreshToken.deleteMany({
            where: inactive,
          });
          // OTPs have no revocation timestamp. Consumption alone is not expiry.
          const phoneOtps = await tx.phoneOtp.deleteMany({
            where: { expiresAt: { lt: cutoff } },
          });
          return {
            sessions: sessions.count,
            refreshTokens: refreshTokens.count,
            phoneOtps: phoneOtps.count,
          };
        },
        { timeout: 60_000 },
      );

      if (result === null) {
        this.logger.debug(
          'Auth record purge skipped: another instance holds the lock',
        );
      } else {
        this.logger.log(
          `Purged auth records: ${JSON.stringify(result)} (retention: ${retentionDays} days)`,
        );
      }
      return result;
    });
  }
}
