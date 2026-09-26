import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile } from '@nestjs/common';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

describe('DataExportController', () => {
  let controller: DataExportController;
  let service: jest.Mocked<DataExportService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DataExportController],
      providers: [
        {
          provide: DataExportService,
          useValue: {
            requestExport: jest.fn(),
            getExportStatus: jest.fn(),
            listMyExports: jest.fn(),
            downloadExport: jest.fn(),
            cleanupExpiredExports: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<DataExportController>(DataExportController);
    service = module.get(DataExportService);
    jest.clearAllMocks();
  });

  describe('requestExport()', () => {
    it('uses the authenticated user id, not the request body', async () => {
      service.requestExport.mockResolvedValue({ id: 'job-1', status: 'COMPLETED' } as any);

      const result = await controller.requestExport('user-1', { scope: 'self' });

      expect(result).toEqual({ id: 'job-1', status: 'COMPLETED' });
      expect(service.requestExport).toHaveBeenCalledWith('user-1');
      expect(service.requestExport).not.toHaveBeenCalledWith(expect.stringContaining('scope'));
    });
  });

  describe('getExportStatus()', () => {
    it('delegates to the service with the requester identity', async () => {
      service.getExportStatus.mockResolvedValue({ id: 'job-1', status: 'PROCESSING' } as any);

      const result = await controller.getExportStatus('user-1', 'job-1');

      expect(result).toEqual({ id: 'job-1', status: 'PROCESSING' } as any);
      expect(service.getExportStatus).toHaveBeenCalledWith('user-1', 'job-1');
    });
  });

  describe('listMyExports()', () => {
    it('lists jobs for the authenticated user only', async () => {
      service.listMyExports.mockResolvedValue([{ id: 'job-1' }] as any);

      const result = await controller.listMyExports('user-1', { page: 1, limit: 20 });

      expect(result).toEqual([{ id: 'job-1' }] as any);
      expect(service.listMyExports).toHaveBeenCalledWith('user-1');
    });
  });

  describe('downloadExport()', () => {
    it('streams the export as an attachment with a JSON content type', async () => {
      service.downloadExport.mockResolvedValue({
        jobId: 'job-1',
        filename: 'hamplard-data-export-job-1.json',
        contentType: 'application/json',
        payload: { data: { profile: { id: 'user-1' } } },
        checksum: 'deadbeef',
        generatedAt: new Date('2026-09-01T00:00:00Z'),
      });

      const file = await controller.downloadExport('user-1', 'job-1');

      expect(file).toBeInstanceOf(StreamableFile);
      expect(file.options.disposition).toContain('attachment');
      expect(file.options.disposition).toContain('hamplard-data-export-job-1.json');
      const json = JSON.parse(Buffer.from(file.getStream().read() as Buffer).toString('utf8'));
      expect(json.data.profile.id).toBe('user-1');
    });
  });

  describe('cleanup()', () => {
    it('delegates to the service', async () => {
      service.cleanupExpiredExports.mockResolvedValue({ count: 2 });

      const result = await controller.cleanup();

      expect(result).toEqual({ count: 2 });
    });
  });
});
