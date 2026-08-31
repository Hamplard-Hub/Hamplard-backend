import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DataExportService } from './data-export.service';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 1024 }),
}));

describe('DataExportService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    dataExportJob: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    certificate: { findMany: jest.fn().mockResolvedValue([]) },
    assignmentSubmission: { findMany: jest.fn().mockResolvedValue([]) },
    notification: { findMany: jest.fn().mockResolvedValue([]) },
    examAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    courseReview: { findMany: jest.fn().mockResolvedValue([]) },
    discussionComment: { findMany: jest.fn().mockResolvedValue([]) },
    refund: { findMany: jest.fn().mockResolvedValue([]) },
    dispute: { findMany: jest.fn().mockResolvedValue([]) },
    kycSubmission: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    couponRedemption: { findMany: jest.fn().mockResolvedValue([]) },
    referral: { findMany: jest.fn().mockResolvedValue([]) },
    referralReward: { findMany: jest.fn().mockResolvedValue([]) },
    wishlistItem: { findMany: jest.fn().mockResolvedValue([]) },
    userPoints: { findUnique: jest.fn().mockResolvedValue(null) },
    pointsAward: { findMany: jest.fn().mockResolvedValue([]) },
    question: { findMany: jest.fn().mockResolvedValue([]) },
    answer: { findMany: jest.fn().mockResolvedValue([]) },
    smsMessage: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const config = {
    get: jest.fn((key: string, defaultVal?: any) => {
      const map: Record<string, any> = {
        DATA_EXPORT_DIR: '/tmp/exports',
      };
      return map[key] ?? defaultVal;
    }),
  };

  beforeEach(() => jest.clearAllMocks());

  describe('requestExport', () => {
    it('creates a new export job', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.dataExportJob.findFirst.mockResolvedValue(null);
      prisma.dataExportJob.create.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        status: 'PENDING',
      });

      const service = new DataExportService(prisma as any, config as any);

      const result = await service.requestExport('user-1');

      expect(result.jobId).toBe('job-1');
      expect(result.status).toBe('PENDING');
      expect(prisma.dataExportJob.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', status: 'PENDING' },
      });
    });

    it('returns existing pending job if one exists', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        status: 'PROCESSING',
      });

      const service = new DataExportService(prisma as any, config as any);

      const result = await service.requestExport('user-1');

      expect(result.jobId).toBe('existing-job');
      expect(result.status).toBe('PROCESSING');
      expect(prisma.dataExportJob.create).not.toHaveBeenCalled();
    });

    it('throws for non-existent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.requestExport('nonexistent')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('getJobStatus', () => {
    it('returns job status for owner', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        status: 'COMPLETED',
        createdAt: new Date(),
        completedAt: new Date(),
        fileSize: 2048,
        errorMessage: null,
      });

      const service = new DataExportService(prisma as any, config as any);

      const result = await service.getJobStatus('user-1', 'job-1');

      expect(result.status).toBe('COMPLETED');
      expect(result.fileSize).toBe(2048);
    });

    it('throws for non-owner', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'other-user',
        status: 'COMPLETED',
      });

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.getJobStatus('user-1', 'job-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws for non-existent job', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue(null);

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.getJobStatus('user-1', 'nonexistent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('hides error message for non-failed jobs', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        status: 'PENDING',
        createdAt: new Date(),
        completedAt: null,
        fileSize: null,
        errorMessage: 'some internal error',
      });

      const service = new DataExportService(prisma as any, config as any);

      const result = await service.getJobStatus('user-1', 'job-1');
      expect(result.errorMessage).toBeUndefined();
    });
  });

  describe('downloadExport', () => {
    it('returns file details for completed job owner', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        status: 'COMPLETED',
        filePath: '/tmp/exports/job-1.json',
      });

      const service = new DataExportService(prisma as any, config as any);

      const result = await service.downloadExport('user-1', 'job-1');

      expect(result.contentType).toBe('application/json');
      expect(result.fileName).toBe('data-export-job-1.json');
    });

    it('throws for non-owner', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'other-user',
        status: 'COMPLETED',
        filePath: '/tmp/exports/job-1.json',
      });

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.downloadExport('user-1', 'job-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws for non-completed job', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        status: 'PROCESSING',
        filePath: null,
      });

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.downloadExport('user-1', 'job-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws for non-existent job', async () => {
      prisma.dataExportJob.findUnique.mockResolvedValue(null);

      const service = new DataExportService(prisma as any, config as any);

      await expect(service.downloadExport('user-1', 'nonexistent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
