import {
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataExportJobStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DataExportService } from './data-export.service';

describe('DataExportService', () => {
  let service: DataExportService;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
    dataExportJob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    enrollment: { findMany: jest.fn() },
    lessonProgress: { findMany: jest.fn() },
    certificate: { findMany: jest.fn() },
    courseReview: { findMany: jest.fn() },
    wishlistItem: { findMany: jest.fn() },
    notification: { findMany: jest.fn() },
    referralReward: { findMany: jest.fn() },
    invoice: { findMany: jest.fn() },
    dispute: { findMany: jest.fn() },
    payout: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DataExportService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get<DataExportService>(DataExportService);
    jest.clearAllMocks();
  });

  const userId = 'user-1';

  const stubCrossModuleQueries = () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: userId,
      name: 'Ada',
      email: 'ada@example.com',
      isBanned: false,
    });
    mockPrisma.enrollment.findMany.mockResolvedValue([]);
    mockPrisma.lessonProgress.findMany.mockResolvedValue([]);
    mockPrisma.certificate.findMany.mockResolvedValue([]);
    mockPrisma.courseReview.findMany.mockResolvedValue([]);
    mockPrisma.wishlistItem.findMany.mockResolvedValue([]);
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.referralReward.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.dispute.findMany.mockResolvedValue([]);
    mockPrisma.payout.findMany.mockResolvedValue([]);
  };

  describe('requestExport()', () => {
    it('throws BadRequestException when no authenticated user id is provided', async () => {
      await expect(service.requestExport('')).rejects.toThrow(BadRequestException);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the user no longer exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.requestExport(userId)).rejects.toThrow(NotFoundException);
    });

    it('rejects banned users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: userId,
        isBanned: true,
        name: 'Ada',
        email: 'ada@example.com',
      });

      await expect(service.requestExport(userId)).rejects.toThrow(BadRequestException);
    });

    it('rejects a second request while another job is in flight', async () => {
      stubCrossModuleQueries();
      mockPrisma.dataExportJob.findFirst
        .mockResolvedValueOnce({ id: 'job-in-flight', status: 'PROCESSING' });

      await expect(service.requestExport(userId)).rejects.toThrow(
        'An export request is already being processed',
      );
    });

    it('enforces the 24h cooldown between requests', async () => {
      stubCrossModuleQueries();
      mockPrisma.dataExportJob.findFirst
        .mockResolvedValueOnce(null) // no in-flight job
        .mockResolvedValueOnce({ id: 'job-old', requestedAt: new Date(Date.now() - 3600_000) });

      await expect(service.requestExport(userId)).rejects.toThrow(
        /You can request a new export in about/i,
      );
    });

    it('creates a job, compiles cross-module data and completes it', async () => {
      stubCrossModuleQueries();
      mockPrisma.dataExportJob.findFirst.mockResolvedValue(null);
      mockPrisma.dataExportJob.create.mockResolvedValue({
        id: 'job-1',
        userId,
        status: DataExportJobStatus.PENDING,
      });
      mockPrisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-1',
        userId,
        status: DataExportJobStatus.PENDING,
      });
      mockPrisma.dataExportJob.update
        .mockResolvedValueOnce({ id: 'job-1', status: DataExportJobStatus.PROCESSING })
        .mockResolvedValueOnce({
          id: 'job-1',
          userId,
          status: DataExportJobStatus.COMPLETED,
          fileSizeBytes: 128,
          checksum: 'abc',
        });
      mockPrisma.enrollment.findMany.mockResolvedValue([
        { id: 'enr-1', courseId: 'course-1', status: 'ACTIVE' },
      ]);

      const result = await service.requestExport(userId);

      expect(result.status).toBe(DataExportJobStatus.COMPLETED);
      expect(mockPrisma.dataExportJob.create).toHaveBeenCalledWith({
        data: { userId, status: DataExportJobStatus.PENDING },
      });
      // Cross-module compilation actually queried the user's own rows only
      expect(mockPrisma.enrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { studentId: userId } }),
      );
      expect(mockPrisma.dataExportJob.update).toHaveBeenCalledTimes(2);
      const completionCall = mockPrisma.dataExportJob.update.mock.calls[1][0];
      expect(completionCall.where).toEqual({ id: 'job-1' });
      expect(completionCall.data.status).toBe(DataExportJobStatus.COMPLETED);
      expect(completionCall.data.payload).toBeDefined();
      expect(completionCall.data.checksum).toBeDefined();
      expect(completionCall.data.expiresAt).toBeInstanceOf(Date);
    });

    it('marks the job FAILED when compilation throws', async () => {
      stubCrossModuleQueries();
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: userId, isBanned: false }) // requestExport guard
        .mockRejectedValueOnce(new Error('profile fetch failed')); // profile section
      mockPrisma.dataExportJob.findFirst.mockResolvedValue(null);
      mockPrisma.dataExportJob.create.mockResolvedValue({
        id: 'job-2',
        userId,
        status: DataExportJobStatus.PENDING,
      });
      mockPrisma.dataExportJob.findUnique.mockResolvedValue({
        id: 'job-2',
        userId,
        status: DataExportJobStatus.PENDING,
      });
      mockPrisma.dataExportJob.update.mockResolvedValue({ id: 'job-2' });

      const result = await service.requestExport(userId);

      // Failure is captured on the job; the API still returns the trackable job
      expect(result.status).toBe(DataExportJobStatus.PENDING);
      const failureCall = mockPrisma.dataExportJob.update.mock.calls.find(
        (call) => call[0].data.status === DataExportJobStatus.FAILED,
      );
      expect(failureCall).toBeDefined();
      expect(failureCall[0].data.errorMessage).toContain('profile fetch failed');
    });
  });

  describe('getExportStatus()', () => {
    it('returns the job when it belongs to the requester', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'COMPLETED' });

      const result = await service.getExportStatus(userId, 'job-1');

      expect(result.id).toBe('job-1');
      expect(mockPrisma.dataExportJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'job-1', userId } }),
      );
    });

    it('hides jobs that belong to another user (identity validation)', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue(null);

      await expect(service.getExportStatus('someone-else', 'job-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listMyExports()', () => {
    it('lists only the requesting user’s jobs, newest first', async () => {
      mockPrisma.dataExportJob.findMany.mockResolvedValue([{ id: 'job-1' }]);

      const result = await service.listMyExports(userId);

      expect(result).toEqual([{ id: 'job-1' }]);
      expect(mockPrisma.dataExportJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          orderBy: { requestedAt: 'desc' },
        }),
      );
    });
  });

  describe('downloadExport()', () => {
    it('throws NotFoundException for a job that is not the requester’s', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue(null);

      await expect(service.downloadExport(userId, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('rejects download before the export is completed', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: DataExportJobStatus.PROCESSING,
      });

      await expect(service.downloadExport(userId, 'job-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects an expired export', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: DataExportJobStatus.EXPIRED,
      });

      await expect(service.downloadExport(userId, 'job-1')).rejects.toThrow(
        'This export has expired',
      );
    });

    it('expires a completed export whose retention window has elapsed', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'job-1',
        userId,
        status: DataExportJobStatus.COMPLETED,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.downloadExport(userId, 'job-1')).rejects.toThrow(
        'This export has expired',
      );
      expect(mockPrisma.dataExportJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data: expect.objectContaining({ status: DataExportJobStatus.EXPIRED }),
        }),
      );
    });

    it('returns the compiled payload with a filename for a valid completed job', async () => {
      const payload = { format: 'hamplard-gdpr-data-export', data: { profile: { id: userId } } };
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'job-1',
        userId,
        status: DataExportJobStatus.COMPLETED,
        payload,
        checksum: 'deadbeef',
        completedAt: new Date('2026-09-01T00:00:00Z'),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      mockPrisma.dataExportJob.update.mockResolvedValue({ id: 'job-1' });

      const result = await service.downloadExport(userId, 'job-1');

      expect(result.filename).toBe('hamplard-data-export-job-1.json');
      expect(result.contentType).toBe('application/json');
      expect(result.payload).toEqual(payload);
      expect(result.checksum).toBe('deadbeef');
      expect(mockPrisma.dataExportJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { downloadCount: { increment: 1 }, lastDownloadAt: expect.any(Date) },
      });
    });

    it('throws InternalServerErrorException when a completed job has no payload', async () => {
      mockPrisma.dataExportJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: DataExportJobStatus.COMPLETED,
        payload: null,
      });

      await expect(service.downloadExport(userId, 'job-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('cleanupExpiredExports()', () => {
    it('expires completed jobs past their retention window', async () => {
      mockPrisma.dataExportJob.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.cleanupExpiredExports();

      expect(result.count).toBe(3);
      expect(mockPrisma.dataExportJob.updateMany).toHaveBeenCalledWith({
        where: {
          status: DataExportJobStatus.COMPLETED,
          expiresAt: { lt: expect.any(Date) },
        },
        data: expect.objectContaining({ status: DataExportJobStatus.EXPIRED }),
      });
    });
  });
});
