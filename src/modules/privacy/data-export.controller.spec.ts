import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, INestApplication, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import * as request from 'supertest';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, ROLES_KEY } from '../../common/guards/roles.guard';

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
    it('lists paginated jobs for the authenticated user only', async () => {
      const paginated = {
        data: [{ id: 'job-1' }],
        meta: { total: 1, page: 2, limit: 10, totalPages: 1 },
      };
      service.listMyExports.mockResolvedValue(paginated as any);

      const result = await controller.listMyExports('user-1', { page: 2, limit: 10 });

      expect(result).toEqual(paginated as any);
      expect(service.listMyExports).toHaveBeenCalledWith('user-1', 2, 10);
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

describe('DataExportController cleanup (Role Authorization)', () => {
  let app: INestApplication;
  let currentUserRole: UserRole = UserRole.STUDENT;

  const mockDataExportService = {
    cleanupExpiredExports: jest.fn().mockResolvedValue({ count: 0 }),
  };

  const mockJwtGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'user-1', role: currentUserRole };
      return true;
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DataExportController],
      providers: [
        { provide: DataExportService, useValue: mockDataExportService },
        Reflector,
        RolesGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('has ADMIN role metadata configured on cleanup handler', () => {
    const reflector = new Reflector();
    const roles = reflector.get<UserRole[]>(ROLES_KEY, DataExportController.prototype.cleanup);
    expect(roles).toEqual([UserRole.ADMIN]);
  });

  it('rejects student callers with 403 Forbidden', async () => {
    currentUserRole = UserRole.STUDENT;

    const response = await request(app.getHttpServer()).post('/privacy/data-exports/cleanup');

    expect(response.status).toBe(403);
    expect(mockDataExportService.cleanupExpiredExports).not.toHaveBeenCalled();
  });

  it('rejects instructor callers with 403 Forbidden', async () => {
    currentUserRole = UserRole.INSTRUCTOR;

    const response = await request(app.getHttpServer()).post('/privacy/data-exports/cleanup');

    expect(response.status).toBe(403);
    expect(mockDataExportService.cleanupExpiredExports).not.toHaveBeenCalled();
  });

  it('allows admin callers', async () => {
    currentUserRole = UserRole.ADMIN;

    const response = await request(app.getHttpServer()).post('/privacy/data-exports/cleanup');

    expect(response.status).toBe(200);
    expect(mockDataExportService.cleanupExpiredExports).toHaveBeenCalledTimes(1);
  });
});
