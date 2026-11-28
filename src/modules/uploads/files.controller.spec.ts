import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CdnService } from './cdn.service';
import { FilesController } from './files.controller';
import { UploadsService } from './uploads.service';
import { VirusScanService } from './virus-scan.service';
import { VideoTranscodeService } from './video-transcode.service';
import { VideoThumbnailService } from './video-thumbnail.service';
import { STORAGE_DRIVER } from './storage';

jest.mock('clamscan', () => jest.fn());

describe('FilesController', () => {
  let controller: FilesController;
  let cdn: CdnService;
  let uploadDir: string;
  let res: { set: jest.Mock };

  const writeUpload = (relativePath: string, content: string | Buffer) => {
    const fullPath = path.join(uploadDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  };

  const signedQuery = (originPath: string) => {
    const { cdnUrl } = cdn.generateCdnUrl(originPath, { visibility: 'private' });
    const url = new URL(cdnUrl);
    return {
      expires: url.searchParams.get('expires') ?? undefined,
      signature: url.searchParams.get('signature') ?? undefined,
    };
  };

  beforeEach(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamplard-uploads-'));
    const configValues: Record<string, string | number> = {
      UPLOAD_DIR: uploadDir,
      CDN_BASE_URL: 'https://cdn.hamplard.com',
      CDN_ORIGIN_BASE_URL: 'http://localhost:3000/api/v1',
      CDN_SIGNING_SECRET: 'test-secret',
      CDN_SIGNED_URL_TTL_SECONDS: 3600,
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        UploadsService,
        CdnService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) =>
              configValues[key] !== undefined ? configValues[key] : defaultValue,
            ),
          },
        },
        { provide: VirusScanService, useValue: { scanFile: jest.fn() } },
        { provide: VideoTranscodeService, useValue: { validateVideoFormat: jest.fn() } },
        { provide: VideoThumbnailService, useValue: { extractThumbnail: jest.fn() } },
        {
          provide: require('../../common/prisma/prisma.service').PrismaService,
          useValue: {},
        },
        {
          provide: STORAGE_DRIVER,
          useValue: {
            writeFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn(async (relativePath: string) => {
              const fullPath = path.join(uploadDir, relativePath);
              return fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null;
            }),
            fileExists: jest.fn(async (relativePath: string) =>
              fs.existsSync(path.join(uploadDir, relativePath)),
            ),
            getFileSize: jest.fn(async (relativePath: string) => {
              const fullPath = path.join(uploadDir, relativePath);
              return fs.existsSync(fullPath) ? fs.statSync(fullPath).size : null;
            }),
            getSignedUrl: jest.fn().mockResolvedValue(null),
            getPublicUrl: jest.fn((relativePath: string) => `/uploads/${relativePath}`),
          },
        },
      ],
    }).compile();

    controller = module.get(FilesController);
    cdn = module.get(CdnService);
    res = { set: jest.fn() };
  });

  afterEach(() => {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('serves public files inline with safe headers', async () => {
    writeUpload('courses/c1/thumb.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const file = await controller.serveFile('courses/c1/thumb.png', undefined, undefined, res as any);

    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.options.type).toBe('image/png');
    expect(file.options.disposition).toBe('inline; filename="thumb.png"');
    expect(file.options.length).toBe(4);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }),
    );
    file.getStream().destroy();
  });

  it('serves unknown types as an octet-stream attachment', async () => {
    writeUpload('resources/page.html', '<script>alert(1)</script>');

    const file = await controller.serveFile('resources/page.html', undefined, undefined, res as any);

    expect(file.options.type).toBe('application/octet-stream');
    expect(file.options.disposition).toBe('attachment; filename="page.html"');
    file.getStream().destroy();
  });

  it('returns 404 for missing files', async () => {
    await expect(
      controller.serveFile('courses/missing.png', undefined, undefined, res as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects path traversal outside the upload directory', async () => {
    await expect(
      controller.serveFile('../../etc/passwd', undefined, undefined, res as any),
    ).rejects.toThrow(BadRequestException);
  });

  describe('private files', () => {
    beforeEach(() => {
      writeUpload('kyc/kyc-inst-1.pdf', '%PDF-1.7');
    });

    it('never serves kyc/ files without a signature', async () => {
      await expect(
        controller.serveFile('kyc/kyc-inst-1.pdf', undefined, undefined, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks kyc/ access smuggled through a relative path', async () => {
      await expect(
        controller.serveFile('courses/../kyc/kyc-inst-1.pdf', undefined, undefined, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects an invalid signature', async () => {
      const { expires } = signedQuery('/uploads/kyc/kyc-inst-1.pdf');

      await expect(
        controller.serveFile('kyc/kyc-inst-1.pdf', expires, 'deadbeef', res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects a signature issued for a different file', async () => {
      const { expires, signature } = signedQuery('/uploads/kyc/other.pdf');

      await expect(
        controller.serveFile('kyc/kyc-inst-1.pdf', expires, signature, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects an expired signature', async () => {
      const { expires, signature } = (() => {
        const { cdnUrl } = cdn.generateCdnUrl('/uploads/kyc/kyc-inst-1.pdf', {
          visibility: 'private',
          expiresInSeconds: -60,
        });
        const url = new URL(cdnUrl);
        return {
          expires: url.searchParams.get('expires') ?? undefined,
          signature: url.searchParams.get('signature') ?? undefined,
        };
      })();

      await expect(
        controller.serveFile('kyc/kyc-inst-1.pdf', expires, signature, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('serves kyc/ files with a valid signature and no caching', async () => {
      const { expires, signature } = signedQuery('/uploads/kyc/kyc-inst-1.pdf');

      const file = await controller.serveFile('kyc/kyc-inst-1.pdf', expires, signature, res as any);

      expect(file).toBeInstanceOf(StreamableFile);
      expect(file.options.type).toBe('application/pdf');
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({ 'Cache-Control': 'private, no-store' }),
      );
      file.getStream().destroy();
    });
  });
});
