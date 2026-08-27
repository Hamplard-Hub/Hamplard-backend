import {
  Injectable,
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

export type CdnAssetVisibility = 'public' | 'private';

export interface CdnUrlOptions {
  /** Whether the asset requires a signed URL */
  visibility?: CdnAssetVisibility;
  /** Signed URL lifetime in seconds (private assets only) */
  expiresInSeconds?: number;
}

export interface SignedUrlValidation {
  valid: boolean;
  expired: boolean;
  path?: string;
  expiresAt?: Date;
  reason?: string;
}

export interface CacheInvalidationRequest {
  id: string;
  paths: string[];
  status: 'pending' | 'completed' | 'failed';
  requestedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface MediaDeliveryUrls {
  /** Relative origin path (e.g. /uploads/videos/abc.mp4) */
  originUrl: string;
  /** CDN delivery URL (signed when private) */
  cdnUrl: string;
  /** Absolute origin fallback URL */
  fallbackUrl: string;
  visibility: CdnAssetVisibility;
  expiresAt?: string;
}

@Injectable()
export class CdnService {
  private readonly logger = new Logger(CdnService.name);
  private readonly cdnBaseUrl: string;
  private readonly originBaseUrl: string;
  private readonly signingSecret: string;
  private readonly defaultSignedTtl: number;
  private readonly invalidations = new Map<string, CacheInvalidationRequest>();

  constructor(private readonly config: ConfigService) {
    this.cdnBaseUrl = this.stripTrailingSlash(
      this.config.get<string>('CDN_BASE_URL', 'https://cdn.hamplard.com'),
    );
    this.originBaseUrl = this.stripTrailingSlash(
      this.config.get<string>(
        'CDN_ORIGIN_BASE_URL',
        this.config.get<string>('APP_BASE_URL', 'http://localhost:3000'),
      ),
    );
    this.signingSecret = this.config.get<string>(
      'CDN_SIGNING_SECRET',
      'hamplard-cdn-dev-secret',
    );
    this.defaultSignedTtl = this.config.get<number>(
      'CDN_SIGNED_URL_TTL_SECONDS',
      3600,
    );
  }

  /**
   * Build a CDN delivery URL for an uploaded asset path.
   * Private assets receive a time-limited signed URL.
   */
  generateCdnUrl(
    assetPath: string,
    options: CdnUrlOptions = {},
  ): MediaDeliveryUrls {
    const normalizedPath = this.normalizePath(assetPath);
    const visibility = options.visibility ?? 'public';
    const fallbackUrl = `${this.originBaseUrl}${normalizedPath}`;

    if (visibility === 'private') {
      const expiresIn =
        options.expiresInSeconds ?? this.defaultSignedTtl;
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const signature = this.sign(normalizedPath, expiresAt);
      const cdnUrl =
        `${this.cdnBaseUrl}${normalizedPath}` +
        `?expires=${expiresAt}&signature=${signature}`;

      return {
        originUrl: normalizedPath,
        cdnUrl,
        fallbackUrl,
        visibility,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      };
    }

    return {
      originUrl: normalizedPath,
      cdnUrl: `${this.cdnBaseUrl}${normalizedPath}`,
      fallbackUrl,
      visibility,
    };
  }

  /**
   * Validate that a signed CDN URL has not expired and the signature matches.
   */
  validateSignedUrl(url: string): SignedUrlValidation {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { valid: false, expired: false, reason: 'Invalid URL' };
    }

    const expiresRaw = parsed.searchParams.get('expires');
    const signature = parsed.searchParams.get('signature');

    if (!expiresRaw || !signature) {
      return {
        valid: false,
        expired: false,
        reason: 'Missing expires or signature query parameters',
      };
    }

    const expiresAtSec = Number(expiresRaw);
    if (!Number.isFinite(expiresAtSec)) {
      return { valid: false, expired: false, reason: 'Invalid expires value' };
    }

    const path = parsed.pathname;
    const expiresAt = new Date(expiresAtSec * 1000);
    const nowSec = Math.floor(Date.now() / 1000);

    if (nowSec > expiresAtSec) {
      return {
        valid: false,
        expired: true,
        path,
        expiresAt,
        reason: 'Signed URL has expired',
      };
    }

    const expected = this.sign(path, expiresAtSec);
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    const signatureMatches =
      expectedBuf.length === signatureBuf.length &&
      crypto.timingSafeEqual(expectedBuf, signatureBuf);

    if (!signatureMatches) {
      return {
        valid: false,
        expired: false,
        path,
        expiresAt,
        reason: 'Invalid signature',
      };
    }

    return { valid: true, expired: false, path, expiresAt };
  }

  /**
   * Assert a signed URL is still valid or throw.
   */
  assertSignedUrlValid(url: string): SignedUrlValidation {
    const result = this.validateSignedUrl(url);
    if (result.expired) {
      throw new UnauthorizedException(result.reason ?? 'Signed URL expired');
    }
    if (!result.valid) {
      throw new BadRequestException(result.reason ?? 'Invalid signed URL');
    }
    return result;
  }

  /**
   * Request CDN cache invalidation for one or more asset paths and track it.
   */
  async invalidateCache(paths: string[]): Promise<CacheInvalidationRequest> {
    if (!paths?.length) {
      throw new BadRequestException('At least one path is required');
    }

    const normalized = paths.map((p) => this.normalizePath(p));
    const request: CacheInvalidationRequest = {
      id: crypto.randomUUID(),
      paths: normalized,
      status: 'pending',
      requestedAt: new Date(),
    };
    this.invalidations.set(request.id, request);

    try {
      const purgeUrl = this.config.get<string>('CDN_PURGE_URL');
      if (purgeUrl) {
        await axios.post(
          purgeUrl,
          { paths: normalized },
          {
            timeout: 5000,
            headers: {
              Authorization: `Bearer ${this.config.get<string>('CDN_PURGE_TOKEN', '')}`,
            },
          },
        );
      }

      request.status = 'completed';
      request.completedAt = new Date();
      this.logger.log(
        `CDN cache invalidation completed: ${request.id} (${normalized.length} paths)`,
      );
    } catch (error) {
      request.status = 'failed';
      request.completedAt = new Date();
      request.error = error?.message ?? 'Unknown purge error';
      this.logger.warn(
        `CDN cache invalidation failed: ${request.id} — ${request.error}`,
      );
    }

    this.invalidations.set(request.id, request);
    return request;
  }

  getInvalidationRequest(id: string): CacheInvalidationRequest | undefined {
    return this.invalidations.get(id);
  }

  listInvalidationRequests(): CacheInvalidationRequest[] {
    return Array.from(this.invalidations.values()).sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    );
  }

  /**
   * Probe the CDN URL; if unavailable, fall back to the origin URL.
   */
  async resolveWithOriginFallback(
    cdnUrl: string,
    originUrl?: string,
  ): Promise<{ url: string; source: 'cdn' | 'origin' }> {
    const fallback =
      originUrl ??
      this.toOriginUrl(cdnUrl);

    try {
      const response = await axios.head(cdnUrl, {
        timeout: 3000,
        validateStatus: (status) => status >= 200 && status < 400,
        maxRedirects: 2,
      });
      if (response.status >= 200 && response.status < 400) {
        return { url: cdnUrl, source: 'cdn' };
      }
    } catch (error) {
      this.logger.warn(
        `CDN miss for ${cdnUrl}: ${error?.message ?? 'unavailable'}; using origin fallback`,
      );
    }

    return { url: fallback, source: 'origin' };
  }

  /**
   * Enrich an upload response (or media object) with CDN delivery URLs.
   */
  attachCdnUrls(
    originPath: string,
    options: CdnUrlOptions = {},
  ): MediaDeliveryUrls {
    return this.generateCdnUrl(originPath, options);
  }

  private sign(path: string, expiresAtSec: number): string {
    return crypto
      .createHmac('sha256', this.signingSecret)
      .update(`${path}:${expiresAtSec}`)
      .digest('hex');
  }

  private toOriginUrl(cdnUrl: string): string {
    try {
      const parsed = new URL(cdnUrl);
      return `${this.originBaseUrl}${parsed.pathname}`;
    } catch {
      return `${this.originBaseUrl}${this.normalizePath(cdnUrl)}`;
    }
  }

  private normalizePath(assetPath: string): string {
    if (!assetPath) {
      throw new BadRequestException('Asset path is required');
    }
    const trimmed = assetPath.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed).pathname;
      } catch {
        throw new BadRequestException('Invalid asset URL');
      }
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  private stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
  }
}
