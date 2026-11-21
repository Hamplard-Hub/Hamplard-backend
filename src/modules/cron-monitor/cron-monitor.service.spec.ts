import { Test, TestingModule } from '@nestjs/testing';
import { CronMonitorService } from './cron-monitor.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CronJobStatus } from '@prisma/client';

describe('CronMonitorService', () => {
  let service: CronMonitorService;

  const mockCreatedRun = {
    id: 'run-1',
    jobName: 'test-cron',
    status: CronJobStatus.RUNNING,
    startedAt: new Date(),
  };

  const mockPrisma = {
    cronJobRun: {
      create: jest.fn().mockResolvedValue(mockCreatedRun),
      update: jest.fn().mockResolvedValue({ ...mockCreatedRun, status: CronJobStatus.SUCCESS }),
      findMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronMonitorService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CronMonitorService>(CronMonitorService);
  });

  it('runs a job callback successfully and updates status to SUCCESS', async () => {
    const callback = jest.fn().mockResolvedValue('ok');

    const result = await service.run('test-cron', callback);

    expect(result).toBe('ok');
    expect(mockPrisma.cronJobRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobName: 'test-cron', status: CronJobStatus.RUNNING }),
      }),
    );
    expect(mockPrisma.cronJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ status: CronJobStatus.SUCCESS }),
      }),
    );
  });

  it('records FAILED status when callback throws an error', async () => {
    const error = new Error('Job failed unexpectedly');
    const callback = jest.fn().mockRejectedValue(error);

    await expect(service.run('failing-cron', callback)).rejects.toThrow('Job failed unexpectedly');

    expect(mockPrisma.cronJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: CronJobStatus.FAILED,
          error: 'Job failed unexpectedly',
        }),
      }),
    );
  });

  it('skips job when skipIf option returns true', async () => {
    const callback = jest.fn();

    await service.run('skip-cron', callback, { skipIf: () => true });

    expect(callback).not.toHaveBeenCalled();
    expect(mockPrisma.cronJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ status: CronJobStatus.SKIPPED }),
      }),
    );
  });
});
