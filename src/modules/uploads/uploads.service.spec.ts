import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { CdnService } from './cdn.service';
import { UploadsService } from './uploads.service';
import { VirusScanService } from './virus-scan.service';

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

describe('UploadsService (CDN integration)', () => {
  let service: UploadsService;
  let cdn: CdnService;

  beforeEach(async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.mkdirSync as jest.Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);

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
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const map: Record<string, string | number> = {
                UPLOAD_DIR: './uploads',
                CDN_BASE_URL: 'https://cdn.hamplard.com',
                CDN_ORIGIN_BASE_URL: 'http://localhost:3000',
                CDN_SIGNING_SECRET: 'test-secret',
                CDN_SIGNED_URL_TTL_SECONDS: 3600,
              };
              return map[key] !== undefined ? map[key] : defaultValue;
            }),
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
      buffer: Buffer.from('x'),
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
      buffer: Buffer.from('pdf'),
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
});
