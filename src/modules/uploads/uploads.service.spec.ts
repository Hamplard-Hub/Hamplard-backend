import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { CdnService } from './cdn.service';
import { UploadsService, isPrivateUploadPath } from './uploads.service';
import { VirusScanService } from './virus-scan.service';
import { VideoTranscodeService } from './video-transcode.service';
import { VideoThumbnailService } from './video-thumbnail.service';
import { STORAGE_DRIVER } from './storage';

jest.mock('clamscan', () => {
  return jest.fn().mockImplementation(() => {
    return {
      init: jest.fn().mockResolvedValue({
        scanBuffer: jest.fn(),
      }),
    };
  });
});

jest.mock('fs');

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n');
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
]);

describe('UploadsService (CDN integration)', () => {
  let service: UploadsService;
  let cdn: CdnService;
  let configValues: Record<string, string | number>;

  beforeEach(async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.mkdirSync as jest.Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);

    configValues = {
      UPLOAD_DIR: './uploads',
      CDN_BASE_URL: 'https://cdn.hamplard.com',
      CDN_ORIGIN_BASE_URL: 'http://localhost:3000',
      CDN_SIGNING_SECRET: 'test-secret',
      CDN_SIGNED_URL_TTL_SECONDS: 3600,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadsService,
        CdnService,
        {
          provide: VirusScanService,
          useValue: {
            scanFile: jest.fn().mockResolvedValue(undefined),
            getScanStatus: jest.fn(),
          },
        },
        // Stubbed so no BullMQ/Redis queue or ffmpeg process is touched.
        {
          provide: VideoTranscodeService,
          useValue: {
            validateVideoFormat: jest.fn(),
            addTranscodeJob: jest.fn().mockResolvedValue('job-1'),
          },
        },
        {
          provide: VideoThumbnailService,
          useValue: { extractThumbnail: jest.fn() },
        },
        {
          provide: require('./video-transcode.service').VideoTranscodeService,
          useValue: {
            validateVideoFormat: jest.fn(),
            addTranscodeJob: jest.fn().mockResolvedValue('job-1'),
            getJobStatus: jest.fn(),
          },
        },
        {
          provide: require('./video-thumbnail.service').VideoThumbnailService,
          useValue: {
            extractThumbnail: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: require('../../common/prisma/prisma.service').PrismaService,
          useValue: {
            cdnInvalidationRequest: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
            fileScanResult: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
          },
        },
        {
          provide: STORAGE_DRIVER,
          useValue: {
            writeFile: jest.fn().mockResolvedValue(undefined),
            readFile: jest.fn().mockResolvedValue(null),
            fileExists: jest.fn().mockResolvedValue(false),
            getFileSize: jest.fn().mockResolvedValue(null),
            getSignedUrl: jest.fn().mockResolvedValue(null),
            getPublicUrl: jest.fn((filePath: string) => `/uploads/${filePath}`),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) =>
              configValues[key] !== undefined ? configValues[key] : defaultValue,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(UploadsService);
    cdn = module.get(CdnService);
    jest.clearAllMocks();
  });

  it('returns CDN URLs when saving a public file', async () => {
    const file = {
      originalname: 'thumb.jpg',
      mimetype: 'image/jpeg',
      size: 1024,
      buffer: JPEG_BYTES,
    } as Express.Multer.File;

    const result = await service.saveFile(file, 'thumbnails');

    expect(result.originUrl).toMatch(/^\/uploads\/thumbnails\//);
    expect(result.cdnUrl).toMatch(/^https:\/\/cdn\.hamplard\.com\/uploads\/thumbnails\//);
    expect(result.url).toBe(result.cdnUrl);
    expect(result.visibility).toBe('public');
  });

  it('returns signed CDN URLs for KYC documents', async () => {
    const file = {
      originalname: 'id.pdf',
      mimetype: 'application/pdf',
      size: 2048,
      buffer: PDF_BYTES,
    } as Express.Multer.File;

    const result = await service.saveKycDocument(file, 'instructor-1');

    expect(result.visibility).toBe('private');
    expect(result.cdnUrl).toContain('signature=');
    expect(cdn.validateSignedUrl(result.cdnUrl).valid).toBe(true);
  });

  it('rejects disallowed MIME types', async () => {
    const file = {
      originalname: 'x.exe',
      mimetype: 'application/octet-stream',
      size: 10,
      buffer: Buffer.from('x'),
    } as Express.Multer.File;

    await expect(service.saveKycDocument(file, 'id')).rejects.toThrow(BadRequestException);
  });

  describe('file validation (issue #283)', () => {
    const makeFile = (overrides: Partial<Express.Multer.File>) =>
      ({
        originalname: 'file.png',
        mimetype: 'image/png',
        size: 1024,
        buffer: PNG_BYTES,
        ...overrides,
      }) as Express.Multer.File;

    it('rejects an HTML file disguised as an image', async () => {
      const file = makeFile({
        originalname: 'evil.html',
        mimetype: 'image/png',
        buffer: Buffer.from('<html><script>alert(1)</script></html>'),
      });

      await expect(service.saveFile(file, 'thumbnails')).rejects.toThrow(BadRequestException);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects SVG uploads', async () => {
      const file = makeFile({
        originalname: 'logo.svg',
        mimetype: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      });

      await expect(service.saveFile(file, 'thumbnails')).rejects.toThrow(BadRequestException);
    });

    it('rejects types outside the category allow-list', async () => {
      const file = makeFile({ originalname: 'doc.pdf', mimetype: 'application/pdf', buffer: PDF_BYTES });

      await expect(service.saveFile(file, 'thumbnails', 'public', 'image')).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.saveFile(file, 'resources', 'public', 'document'),
      ).resolves.toBeDefined();
    });

    it('derives the extension from the detected content, not the client filename', async () => {
      const file = makeFile({ originalname: 'photo.html', mimetype: 'image/jpeg', buffer: JPEG_BYTES });

      const result = await service.saveFile(file, 'thumbnails');

      expect(result.originUrl).toMatch(/\.jpg$/);
      expect(result.originUrl).not.toContain('.html');
    });

    it('rejects files larger than the configured category limit', async () => {
      configValues.MAX_IMAGE_SIZE_MB = 1;
      const file = makeFile({ size: 2 * 1024 * 1024 });

      await expect(service.saveFile(file, 'thumbnails')).rejects.toThrow(BadRequestException);
    });

    it('applies MAX_FILE_SIZE_MB as a global ceiling', async () => {
      configValues.MAX_FILE_SIZE_MB = '1';
      const file = makeFile({ originalname: 'id.pdf', mimetype: 'application/pdf', buffer: PDF_BYTES, size: 2 * 1024 * 1024 });

      await expect(service.saveKycDocument(file, 'instructor-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('validates video content and size', async () => {
      configValues.MAX_VIDEO_SIZE_MB = 1;
      const tooBig = makeFile({
        originalname: 'lesson.mp4',
        mimetype: 'video/mp4',
        buffer: MP4_BYTES,
        size: 2 * 1024 * 1024,
      });
      const fake = makeFile({
        originalname: 'lesson.mp4',
        mimetype: 'video/mp4',
        buffer: Buffer.from('not a video at all'),
      });

      await expect(service.saveVideo(tooBig, 'videos', 'lesson-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.saveVideo(fake, 'videos', 'lesson-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

/** Issue #335 — lesson media is stored as a private asset. */
describe('isPrivateUploadPath', () => {
  it('treats lesson media under courses/<id>/lessons/ as private', () => {
    expect(isPrivateUploadPath('courses/c1/lessons/l1/video.mp4')).toBe(true);
    expect(isPrivateUploadPath('courses/c1/lessons/l1/transcoded/720p.mp4')).toBe(true);
  });

  it('keeps existing private folders private', () => {
    expect(isPrivateUploadPath('kyc/doc.pdf')).toBe(true);
    expect(isPrivateUploadPath('certificates/cert.pdf')).toBe(true);
  });

  it('leaves public course assets and thumbnails public', () => {
    expect(isPrivateUploadPath('courses/c1/cover.png')).toBe(false);
    expect(isPrivateUploadPath('thumbnails/t.jpg')).toBe(false);
  });
});
