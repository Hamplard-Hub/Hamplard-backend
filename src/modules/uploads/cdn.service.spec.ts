import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { CdnService } from './cdn.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('CdnService', () => {
  let service: CdnService;

  const configMap: Record<string, string | number> = {
    CDN_BASE_URL: 'https://cdn.hamplard.com',
    CDN_ORIGIN_BASE_URL: 'http://localhost:3000',
    CDN_SIGNING_SECRET: 'test-secret',
    CDN_SIGNED_URL_TTL_SECONDS: 3600,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CdnService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) =>
              configMap[key] !== undefined ? configMap[key] : defaultValue,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(CdnService);
    jest.clearAllMocks();
    delete configMap.CDN_PURGE_URL;
  });

  describe('generateCdnUrl()', () => {
    it('generates a public CDN URL for an upload path', () => {
      const result = service.generateCdnUrl('/uploads/videos/lesson.mp4');

      expect(result.originUrl).toBe('/uploads/videos/lesson.mp4');
      expect(result.cdnUrl).toBe('https://cdn.hamplard.com/uploads/videos/lesson.mp4');
      expect(result.fallbackUrl).toBe('http://localhost:3000/uploads/videos/lesson.mp4');
      expect(result.visibility).toBe('public');
      expect(result.expiresAt).toBeUndefined();
    });

    it('generates a signed CDN URL for private assets', () => {
      const result = service.generateCdnUrl('/uploads/kyc/doc.pdf', {
        visibility: 'private',
        expiresInSeconds: 120,
      });

      expect(result.cdnUrl).toContain('https://cdn.hamplard.com/uploads/kyc/doc.pdf?expires=');
      expect(result.cdnUrl).toContain('&signature=');
      expect(result.visibility).toBe('private');
      expect(result.expiresAt).toBeDefined();
    });
  });

  describe('validateSignedUrl()', () => {
    it('validates a fresh signed URL', () => {
      const { cdnUrl } = service.generateCdnUrl('/uploads/private/a.mp4', {
        visibility: 'private',
        expiresInSeconds: 600,
      });

      const validation = service.validateSignedUrl(cdnUrl);
      expect(validation.valid).toBe(true);
      expect(validation.expired).toBe(false);
      expect(validation.path).toBe('/uploads/private/a.mp4');
    });

    it('rejects an expired signed URL', () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      const path = '/uploads/private/old.mp4';
      const signature = (service as any).sign(path, past);
      const url =
        `https://cdn.hamplard.com${path}?expires=${past}&signature=${signature}`;

      const validation = service.validateSignedUrl(url);
      expect(validation.valid).toBe(false);
      expect(validation.expired).toBe(true);
    });

    it('throws UnauthorizedException via assertSignedUrlValid when expired', () => {
      const past = Math.floor(Date.now() / 1000) - 5;
      const path = '/uploads/private/old.mp4';
      const signature = (service as any).sign(path, past);
      const url =
        `https://cdn.hamplard.com${path}?expires=${past}&signature=${signature}`;

      expect(() => service.assertSignedUrlValid(url)).toThrow(UnauthorizedException);
    });

    it('throws BadRequestException for invalid signatures', () => {
      const future = Math.floor(Date.now() / 1000) + 600;
      const url =
        `https://cdn.hamplard.com/uploads/x.mp4?expires=${future}&signature=deadbeef`;

      expect(() => service.assertSignedUrlValid(url)).toThrow(BadRequestException);
    });
  });

  describe('invalidateCache()', () => {
    it('tracks completed invalidation requests when no purge URL is configured', async () => {
      const request = await service.invalidateCache([
        '/uploads/videos/a.mp4',
        'uploads/thumbs/b.jpg',
      ]);

      expect(request.status).toBe('completed');
      expect(request.paths).toEqual([
        '/uploads/videos/a.mp4',
        '/uploads/thumbs/b.jpg',
      ]);
      expect(service.getInvalidationRequest(request.id)).toEqual(request);
      expect(service.listInvalidationRequests()).toHaveLength(1);
    });

    it('tracks failed invalidation when purge endpoint errors', async () => {
      configMap.CDN_PURGE_URL = 'https://cdn.hamplard.com/api/purge';
      mockedAxios.post.mockRejectedValueOnce(new Error('purge down'));

      // Rebuild service so ConfigService sees purge URL
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CdnService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) =>
                configMap[key] !== undefined ? configMap[key] : defaultValue,
              ),
            },
          },
        ],
      }).compile();
      const cdn = module.get(CdnService);

      const request = await cdn.invalidateCache(['/uploads/a.mp4']);
      expect(request.status).toBe('failed');
      expect(request.error).toContain('purge down');
    });

    it('rejects empty path lists', async () => {
      await expect(service.invalidateCache([])).rejects.toThrow(BadRequestException);
    });
  });

  describe('resolveWithOriginFallback()', () => {
    it('returns the CDN URL when the asset is available', async () => {
      mockedAxios.head.mockResolvedValueOnce({ status: 200 });

      const result = await service.resolveWithOriginFallback(
        'https://cdn.hamplard.com/uploads/v.mp4',
      );

      expect(result).toEqual({
        url: 'https://cdn.hamplard.com/uploads/v.mp4',
        source: 'cdn',
      });
    });

    it('falls back to origin when CDN is unavailable', async () => {
      mockedAxios.head.mockRejectedValueOnce(new Error('timeout'));

      const result = await service.resolveWithOriginFallback(
        'https://cdn.hamplard.com/uploads/v.mp4',
      );

      expect(result).toEqual({
        url: 'http://localhost:3000/uploads/v.mp4',
        source: 'origin',
      });
    });
  });
});
