import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import * as request from 'supertest';
import { UserRole } from '@prisma/client';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';

/** Issue #313 — GET /invoices/my and GET /invoices/:id/download. */
describe('InvoicesController (HTTP)', () => {
  let app: INestApplication;

  const mockService = {
    findMine: jest.fn(),
    getPdfForDownload: jest.fn(),
  };

  const STUDENT = { id: 'student-1', role: UserRole.STUDENT };

  // Stand-in for JwtAuthGuard: no bearer token → 401, otherwise attach a user.
  const mockJwtGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      if (!req.headers.authorization) throw new UnauthorizedException();
      req.user = STUDENT;
      return true;
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [{ provide: InvoicesService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror the production bootstrap in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /invoices/my', () => {
    it('lists the authenticated student\'s invoices using their own id', async () => {
      const page = {
        data: [{ id: 'inv-1', invoiceNumber: 1 }],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      };
      mockService.findMine.mockResolvedValue(page);

      const res = await request(app.getHttpServer())
        .get('/invoices/my')
        .set('Authorization', 'Bearer token')
        .expect(200);

      expect(mockService.findMine).toHaveBeenCalledWith('student-1', 1, 20);
      expect(res.body.data).toEqual(page);
    });

    it('passes page and limit query params through as numbers', async () => {
      mockService.findMine.mockResolvedValue({ data: [], meta: {} });

      await request(app.getHttpServer())
        .get('/invoices/my?page=3&limit=5')
        .set('Authorization', 'Bearer token')
        .expect(200);

      expect(mockService.findMine).toHaveBeenCalledWith('student-1', 3, 5);
    });

    it('rejects a client-supplied studentId so one student cannot list another\'s invoices', async () => {
      await request(app.getHttpServer())
        .get('/invoices/my?studentId=student-2')
        .set('Authorization', 'Bearer token')
        .expect(400);

      expect(mockService.findMine).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range limit', async () => {
      await request(app.getHttpServer())
        .get('/invoices/my?limit=1000')
        .set('Authorization', 'Bearer token')
        .expect(400);
    });

    it('returns 401 for anonymous callers', async () => {
      await request(app.getHttpServer()).get('/invoices/my').expect(401);
      expect(mockService.findMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /invoices/:id/download', () => {
    it('streams the PDF with attachment headers', async () => {
      const pdf = Buffer.from('%PDF-1.4 invoice body');
      mockService.getPdfForDownload.mockResolvedValue({ buffer: pdf, filename: 'invoice-42.pdf' });

      const res = await request(app.getHttpServer())
        .get('/invoices/inv-1/download')
        .set('Authorization', 'Bearer token')
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="invoice-42.pdf"');
      expect(Buffer.compare(res.body, pdf)).toBe(0);
      expect(mockService.getPdfForDownload).toHaveBeenCalledWith('inv-1', STUDENT);
    });

    it('returns 404 when the caller does not own the invoice', async () => {
      mockService.getPdfForDownload.mockRejectedValue(new NotFoundException('Invoice not found'));

      const res = await request(app.getHttpServer())
        .get('/invoices/inv-other/download')
        .set('Authorization', 'Bearer token')
        .expect(404);

      expect(res.headers['content-type']).not.toContain('application/pdf');
    });

    it('returns 401 for anonymous callers', async () => {
      await request(app.getHttpServer()).get('/invoices/inv-1/download').expect(401);
      expect(mockService.getPdfForDownload).not.toHaveBeenCalled();
    });
  });
});
