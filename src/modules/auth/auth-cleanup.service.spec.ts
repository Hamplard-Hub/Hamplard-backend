import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CronMonitorService } from '../cron-monitor/cron-monitor.service';
import { AuthCleanupModule } from './auth-cleanup.module';
import { AuthCleanupService } from './auth-cleanup.service';

describe('AuthCleanupService', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  let service: AuthCleanupService;
  let config: ConfigService;
  let tx: {
    $queryRaw: jest.Mock;
    session: { deleteMany: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
    phoneOtp: { deleteMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let monitor: { run: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());
    config = new ConfigService();
    jest.spyOn(config, 'get').mockReturnValue(30);
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
      session: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      phoneOtp: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
    };
    prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    monitor = { run: jest.fn((_name, callback) => callback()) };
    service = new AuthCleanupService(
      prisma as unknown as PrismaService,
      config,
      monitor as unknown as CronMonitorService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('registers a daily UTC cron and can resolve its module dependencies', async () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      service.purgeExpiredRecords,
    );
    expect(options).toMatchObject({
      name: 'auth-record-purge',
      timeZone: 'UTC',
      cronTime: CronExpression.EVERY_DAY_AT_MIDNIGHT,
    });
    const module = await Test.createTestingModule({
      imports: [AuthCleanupModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(CronMonitorService)
      .useValue(monitor)
      .compile();
    expect(module.get(AuthCleanupService)).toBeInstanceOf(AuthCleanupService);
    await module.close();
  });

  it.each([30, '7'])(
    'uses a strict shared cutoff for retention %s',
    async (days) => {
      jest.spyOn(config, 'get').mockReturnValue(days);
      const cutoff = new Date(now.getTime() - Number(days) * 86_400_000);
      await expect(service.purgeExpiredRecords()).resolves.toEqual({
        sessions: 2,
        refreshTokens: 3,
        phoneOtps: 4,
      });
      expect(config.get).toHaveBeenCalledWith('AUTH_RECORD_RETENTION_DAYS', 30);
      const predicate = {
        where: {
          OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
        },
      };
      expect(tx.session.deleteMany).toHaveBeenCalledWith(predicate);
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith(predicate);
      expect(tx.phoneOtp.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: cutoff } },
      });
      expect(monitor.run).toHaveBeenCalledWith(
        'auth-record-purge',
        expect.any(Function),
      );
    },
  );

  it.each([
    '',
    'abc',
    '-1',
    '0',
    '1.5',
    'Infinity',
    Number.MAX_SAFE_INTEGER,
    true,
    null,
  ])('fails invalid retention %s before deleting anything', async (value) => {
    jest.spyOn(config, 'get').mockReturnValue(value);
    await expect(service.purgeExpiredRecords()).rejects.toThrow(
      'AUTH_RECORD_RETENTION_DAYS',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips all deletes when another instance owns the lock', async () => {
    tx.$queryRaw.mockResolvedValue([{ acquired: false }]);
    await expect(service.purgeExpiredRecords()).resolves.toBeNull();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.phoneOtp.deleteMany).not.toHaveBeenCalled();
  });

  it('propagates database failure to the cron monitor', async () => {
    const error = new Error('database unavailable');
    tx.refreshToken.deleteMany.mockRejectedValue(error);
    await expect(service.purgeExpiredRecords()).rejects.toBe(error);
    expect(tx.phoneOtp.deleteMany).not.toHaveBeenCalled();
  });
});
