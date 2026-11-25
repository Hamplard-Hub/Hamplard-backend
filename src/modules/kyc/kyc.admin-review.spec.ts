import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  Logger,
  NotFoundException,
  StreamableFile,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { KycStatus, UserRole } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CdnService } from '../uploads/cdn.service';
import { FilesController } from '../uploads/files.controller';
import { UploadsService } from '../uploads/uploads.service';
import { VideoThumbnailService } from '../uploads/video-thumbnail.service';
import { VideoTranscodeService } from '../uploads/video-transcode.service';
import { VirusScanService } from '../uploads/virus-scan.service';
import { KycController } from './kyc.controller';
import { KYC_REVIEW_URL_TTL_SECONDS, KycService } from './kyc.service';

jest.mock('clamscan', () => jest.fn());

/**
 * Issue #442 — admin KYC review endpoints must hand out short-lived signed
 * URLs (not raw private origin paths), without persisting them.
 */
describe('KYC admin review — signed document URLs (issue #442)', () => {
  const DOC_PATH = '/uploads/kyc/kyc-instructor-1-doc.pdf';
  const SELFIE_PATH = '/uploads/kyc/kyc-instructor-1-selfie.jpg';

  const withBoth = () => ({
    id: 'sub-1',
    instructorId: 'instructor-1',
    documentType: 'PASSPORT',
    documentUrl: DOC_PATH,
    additionalUrl: SELFIE_PATH,
    status: KycStatus.PENDING,
    adminNotes: null,
    reviewedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    instructor: { id: 'instructor-1', name: 'Ada', stellarAddress: 'GABC' },
    reviewedBy: null,
  });
  const withoutAdditional = () => ({
    ...withBoth(),
    id: 'sub-2',
    documentUrl: '/uploads/kyc/kyc-instructor-2-doc.pdf',
    additionalUrl: null,
  });

  let uploadDir: string;
  let kyc: KycService;
  let cdn: CdnService;
  let files: FilesController;
  let prisma: any;
  let logSpy: jest.SpyInstance;
  let openStreams: Array<NodeJS.ReadableStream & { destroy(): void; closed?: boolean; once: any }>;

  beforeEach(async () => {
    openStreams = [];
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamplard-kyc-'));
    const config: Record<string, string | number> = {
      UPLOAD_DIR: uploadDir,
      CDN_BASE_URL: 'https://cdn.hamplard.com',
      CDN_ORIGIN_BASE_URL: 'http://localhost:3000/api/v1',
      CDN_SIGNING_SECRET: 'test-secret',
      CDN_SIGNED_URL_TTL_SECONDS: 3600,
    };

    prisma = {
      kycSubmission: {
        findMany: jest.fn().mockResolvedValue([withBoth(), withoutAdditional()]),
        findUnique: jest.fn().mockResolvedValue(withBoth()),
        count: jest.fn().mockResolvedValue(2),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        KycService,
        UploadsService,
        CdnService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn((k: string, d?: unknown) => config[k] ?? d) } },
        { provide: VirusScanService, useValue: {} },
        { provide: VideoTranscodeService, useValue: {} },
        { provide: VideoThumbnailService, useValue: {} },
      ],
    }).compile();

    kyc = module.get(KycService);
    cdn = module.get(CdnService);
    files = module.get(FilesController);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    for (const p of [DOC_PATH, SELFIE_PATH]) {
      const full = path.join(uploadDir, p.replace(/^\/uploads\//, ''));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'identity-document-bytes');
    }
  });

  afterEach(async () => {
    logSpy.mockRestore();
    // Let every stream we opened finish closing before deleting the files.
    await Promise.all(
      openStreams.map((stream) =>
        stream.closed ? undefined : new Promise((resolve) => stream.once('close', resolve)),
      ),
    );
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  /** Fetch a URL path through the real FilesController (as the browser would). */
  const fetchViaOrigin = (url: string) => {
    const parsed = new URL(url);
    // CDN URLs are /uploads/..., origin fallbacks are /api/v1/uploads/...
    const filePath = parsed.pathname.replace(/^.*?\/uploads\//, '');
    const file = files.serveFile(
      filePath,
      parsed.searchParams.get('expires') ?? undefined,
      parsed.searchParams.get('signature') ?? undefined,
      { set: jest.fn() } as any,
    );
    // Close the read stream; afterEach waits for it before cleaning up.
    const stream = file.getStream() as any;
    openStreams.push(stream);
    stream.destroy();
    return file;
  };

  const expectSignedFor = (url: string, originPath: string) => {
    expect(url.startsWith(`https://cdn.hamplard.com${originPath}?expires=`)).toBe(true);
    expect(cdn.validateSignedUrl(url)).toMatchObject({ valid: true, path: originPath });
  };

  describe('findAll()', () => {
    it('returns signed URLs for documentUrl and additionalUrl', async () => {
      const { data, meta } = await kyc.findAll('admin-1', 1, 20);

      expect(meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
      expectSignedFor(data[0].documentUrl, DOC_PATH);
      expectSignedFor(data[0].additionalUrl!, SELFIE_PATH);
      expect(data[0].documentDelivery).toMatchObject({ originUrl: DOC_PATH, visibility: 'private' });
      expect(data[0].additionalDelivery).toMatchObject({ originUrl: SELFIE_PATH, visibility: 'private' });
    });

    it('handles a missing optional additionalUrl', async () => {
      const { data } = await kyc.findAll('admin-1');

      expectSignedFor(data[1].documentUrl, '/uploads/kyc/kyc-instructor-2-doc.pdf');
      expect(data[1].additionalUrl).toBeNull();
      expect(data[1].additionalDelivery).toBeNull();
    });

    it('keeps the existing response fields (instructor, status, pagination)', async () => {
      const { data } = await kyc.findAll('admin-1', 1, 20, KycStatus.PENDING);

      expect(prisma.kycSubmission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: KycStatus.PENDING }, skip: 0, take: 20 }),
      );
      expect(data[0]).toMatchObject({
        id: 'sub-1',
        status: KycStatus.PENDING,
        documentType: 'PASSPORT',
        instructor: { id: 'instructor-1', name: 'Ada', stellarAddress: 'GABC' },
      });
    });

    it('does not log anything when the page is empty', async () => {
      prisma.kycSubmission.findMany.mockResolvedValue([]);
      prisma.kycSubmission.count.mockResolvedValue(0);
      await kyc.findAll('admin-1');
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('KYC document URLs signed'));
    });
  });

  describe('findOne()', () => {
    it('returns signed URLs for both documents', async () => {
      const result = await kyc.findOne('sub-1', 'admin-1');

      expectSignedFor(result.documentUrl, DOC_PATH);
      expectSignedFor(result.additionalUrl!, SELFIE_PATH);
      expect(result.instructor).toEqual({ id: 'instructor-1', name: 'Ada', stellarAddress: 'GABC' });
    });

    it('handles a missing optional additionalUrl', async () => {
      prisma.kycSubmission.findUnique.mockResolvedValue(withoutAdditional());
      const result = await kyc.findOne('sub-2', 'admin-1');

      expect(result.additionalUrl).toBeNull();
      expect(result.additionalDelivery).toBeNull();
    });

    it('throws NotFoundException and signs nothing for unknown ids', async () => {
      prisma.kycSubmission.findUnique.mockResolvedValue(null);
      await expect(kyc.findOne('missing', 'admin-1')).rejects.toThrow(NotFoundException);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('KYC document URLs signed'));
    });
  });

  describe('TTL', () => {
    it(`expires after ${KYC_REVIEW_URL_TTL_SECONDS}s — shorter than the CDN default`, async () => {
      expect(KYC_REVIEW_URL_TTL_SECONDS).toBe(15 * 60);
      expect(KYC_REVIEW_URL_TTL_SECONDS).toBeLessThan(3600);

      const before = Math.floor(Date.now() / 1000);
      const result = await kyc.findOne('sub-1', 'admin-1');
      const after = Math.floor(Date.now() / 1000);

      for (const url of [result.documentUrl, result.additionalUrl!]) {
        const expires = Number(new URL(url).searchParams.get('expires'));
        expect(expires).toBeGreaterThanOrEqual(before + KYC_REVIEW_URL_TTL_SECONDS);
        expect(expires).toBeLessThanOrEqual(after + KYC_REVIEW_URL_TTL_SECONDS);
      }
    });

    it('URLs stop working once the TTL has elapsed', async () => {
      const result = await kyc.findOne('sub-1', 'admin-1');
      jest.useFakeTimers({ now: Date.now() + (KYC_REVIEW_URL_TTL_SECONDS + 5) * 1000 });
      try {
        expect(cdn.validateSignedUrl(result.documentUrl)).toMatchObject({ valid: false, expired: true });
        expect(() => fetchViaOrigin(result.documentUrl)).toThrow(ForbiddenException);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('private-folder protection', () => {
    it('signed URLs open the private documents through the file server', async () => {
      const result = await kyc.findOne('sub-1', 'admin-1');

      expect(fetchViaOrigin(result.documentUrl)).toBeInstanceOf(StreamableFile);
      expect(fetchViaOrigin(result.additionalUrl!)).toBeInstanceOf(StreamableFile);
      // The origin fallback URL carries the same signature.
      expect(fetchViaOrigin(result.documentDelivery.fallbackUrl)).toBeInstanceOf(StreamableFile);
    });

    it('unsigned stored paths are still rejected with 403', () => {
      expect(() => fetchViaOrigin(`http://localhost${DOC_PATH}`)).toThrow(ForbiddenException);
    });

    it('a signature for one document cannot open another', async () => {
      const result = await kyc.findOne('sub-1', 'admin-1');
      const forged = new URL(result.documentUrl);
      forged.pathname = SELFIE_PATH;
      expect(() => fetchViaOrigin(forged.toString())).toThrow(ForbiddenException);
    });
  });

  describe('persistence', () => {
    it('never writes signed URLs back to the database', async () => {
      await kyc.findAll('admin-1');
      await kyc.findOne('sub-1', 'admin-1');

      expect(prisma.kycSubmission.update).not.toHaveBeenCalled();
      expect(prisma.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(prisma.kycSubmission.create).not.toHaveBeenCalled();
    });

    it('does not mutate the stored record returned by Prisma', async () => {
      const stored = withBoth();
      prisma.kycSubmission.findUnique.mockResolvedValue(stored);
      await kyc.findOne('sub-1', 'admin-1');

      expect(stored.documentUrl).toBe(DOC_PATH);
      expect(stored.additionalUrl).toBe(SELFIE_PATH);
    });
  });

  describe('access logging', () => {
    it('logs admin id, submission ids and expiry — but no URL, path or signature', async () => {
      const { data } = await kyc.findAll('admin-1');
      const lines = logSpy.mock.calls
        .map(([msg]) => String(msg))
        .filter((m) => m.includes('KYC document URLs signed'));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('admin admin-1');
      expect(lines[0]).toContain('sub-1');
      expect(lines[0]).toContain('sub-2');
      expect(lines[0]).toContain(`ttl ${KYC_REVIEW_URL_TTL_SECONDS}s`);
      const signature = new URL(data[0].documentUrl).searchParams.get('signature')!;
      expect(lines[0]).not.toContain(signature);
      expect(lines[0]).not.toContain('/uploads/');
      expect(lines[0]).not.toContain('test-secret');
    });

    it('findOne logs the access too', async () => {
      await kyc.findOne('sub-1', 'admin-1');
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/KYC document URLs signed for admin admin-1: submissions \[sub-1\]/));
    });
  });

  describe('internal review/revoke lookups', () => {
    it('review() does not sign URLs or log document access', async () => {
      const signSpy = jest.spyOn(cdn, 'generateCdnUrl');
      prisma.kycSubmission.findUnique.mockResolvedValue({ ...withBoth(), status: KycStatus.APPROVED });

      await expect(
        kyc.review('sub-1', 'admin-1', { status: KycStatus.APPROVED } as any),
      ).rejects.toThrow('Only PENDING or UNDER_REVIEW submissions can be reviewed');
      expect(signSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('KYC document URLs signed'));
    });
  });
});

describe('KycController admin review routes — authorization (issue #442)', () => {
  /** Authenticates from a header; the controller's real RolesGuard decides access. */
  class HeaderAuthGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers['x-test-role'];
      if (!role) return false;
      req.user = { id: `${String(role).toLowerCase()}-1`, role };
      return true;
    }
  }

  let app: INestApplication;
  const kycService = {
    findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } }),
    findOne: jest.fn().mockResolvedValue({ id: 'sub-1' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KycController],
      providers: [{ provide: KycService, useValue: kycService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['GET /kyc', '/kyc'],
    ['GET /kyc/:id', '/kyc/sub-1'],
  ])('%s forbids instructors and students', async (_label, url) => {
    for (const role of [UserRole.INSTRUCTOR, UserRole.STUDENT]) {
      const res = await request(app.getHttpServer()).get(url).set('x-test-role', role);
      expect(res.status).toBe(403);
    }
    expect(kycService.findAll).not.toHaveBeenCalled();
    expect(kycService.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['GET /kyc', '/kyc'],
    ['GET /kyc/:id', '/kyc/sub-1'],
  ])('%s rejects unauthenticated callers', async (_label, url) => {
    const res = await request(app.getHttpServer()).get(url);
    expect(res.status).toBe(403);
    expect(kycService.findAll).not.toHaveBeenCalled();
    expect(kycService.findOne).not.toHaveBeenCalled();
  });

  it('passes the admin id through so access can be attributed', async () => {
    await request(app.getHttpServer()).get('/kyc?page=2&limit=10').set('x-test-role', UserRole.ADMIN).expect(200);
    expect(kycService.findAll).toHaveBeenCalledWith('admin-1', 2, 10, undefined);

    await request(app.getHttpServer()).get('/kyc/sub-1').set('x-test-role', UserRole.ADMIN).expect(200);
    expect(kycService.findOne).toHaveBeenCalledWith('sub-1', 'admin-1');
  });
});
