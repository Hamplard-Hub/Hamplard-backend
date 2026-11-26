import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CronMonitorService } from '../cron-monitor/cron-monitor.service';
import { AuthCleanupService } from './auth-cleanup.service';

// Explicitly opt in with a disposable database; never use DATABASE_URL as a fallback.
const databaseUrl = process.env.AUTH_PURGE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Auth record purge (PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: AuthCleanupService;
  let userId: string;
  const now = new Date('2026-11-25T00:00:00Z');
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const old = new Date(cutoff.getTime() - 1);
  const recent = new Date(cutoff.getTime() + 1);
  const future = new Date(now.getTime() + 86_400_000);

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
    service = new AuthCleanupService(
      prisma,
      new ConfigService({ AUTH_RECORD_RETENTION_DAYS: 30 }),
      {
        run: (_name: string, callback: () => Promise<unknown>) => callback(),
      } as CronMonitorService,
    );
  });

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    userId = (await prisma.user.create({ data: {} })).id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('removes only old expiry/revocation and is idempotent', async () => {
    const cases = [
      { name: 'old-expired', expiresAt: old },
      { name: 'old-revoked', expiresAt: future, revokedAt: old },
      { name: 'recent-expired', expiresAt: recent },
      { name: 'recent-revoked', expiresAt: future, revokedAt: recent },
      { name: 'boundary-expiry', expiresAt: cutoff },
      { name: 'boundary-revocation', expiresAt: future, revokedAt: cutoff },
      { name: 'active', expiresAt: future },
    ];
    for (const { name, ...dates } of cases) {
      await prisma.session.create({
        data: {
          userId,
          jti: randomUUID(),
          deviceLabel: name,
          createdAt: old,
          ...dates,
        },
      });
      await prisma.refreshToken.create({
        data: {
          userId,
          familyId: name,
          generation: 1,
          tokenHash: randomUUID(),
          createdAt: old,
          consumedAt: old,
          ...dates,
        },
      });
    }
    for (const [name, expiresAt] of [
      ['old', old],
      ['recent', recent],
      ['boundary', cutoff],
      ['active', future],
    ] as const) {
      await prisma.phoneOtp.create({
        data: {
          userId,
          phoneNumber: name,
          countryCode: '+1',
          otp: 'test-only',
          expiresAt,
          isUsed: true,
          verifiedAt: old,
        },
      });
    }
    await expect(service.purgeExpiredRecords()).resolves.toEqual({
      sessions: 2,
      refreshTokens: 2,
      phoneOtps: 1,
    });
    const kept = [
      'active',
      'boundary-expiry',
      'boundary-revocation',
      'recent-expired',
      'recent-revoked',
    ];
    expect(
      (await prisma.session.findMany({ where: { userId } }))
        .map((row) => row.deviceLabel)
        .sort(),
    ).toEqual(kept);
    expect(
      (await prisma.refreshToken.findMany({ where: { userId } }))
        .map((row) => row.familyId)
        .sort(),
    ).toEqual(kept);
    expect(
      (await prisma.phoneOtp.findMany({ where: { userId } }))
        .map((row) => row.phoneNumber)
        .sort(),
    ).toEqual(['active', 'boundary', 'recent']);
    await expect(service.purgeExpiredRecords()).resolves.toEqual({
      sessions: 0,
      refreshTokens: 0,
      phoneOtps: 0,
    });
  });

  it('skips a competing transaction and runs once that transaction releases the lock', async () => {
    await prisma.session.create({
      data: { userId, jti: randomUUID(), expiresAt: old },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('hamplard:auth-record-purge'))::text`;
      await expect(service.purgeExpiredRecords()).resolves.toBeNull();
      expect(await prisma.session.count({ where: { userId } })).toBe(1);
    });
    await expect(service.purgeExpiredRecords()).resolves.toEqual({
      sessions: 1,
      refreshTokens: 0,
      phoneOtps: 0,
    });
  });
});
