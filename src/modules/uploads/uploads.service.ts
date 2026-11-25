import {
  Injectable, BadRequestException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';
import { CdnAssetVisibility, CdnService, MediaDeliveryUrls } from './cdn.service';
import { VirusScanService } from './virus-scan.service';
import { VideoTranscodeService } from './video-transcode.service';
import { VideoThumbnailService, ThumbnailResult } from './video-thumbnail.service';
import { DetectedFileType, detectFileType, INLINE_CONTENT_TYPES } from './file-type.util';
import { getNumberConfig } from '../../common/config/env.util';

export type UploadCategory = 'image' | 'document' | 'kyc' | 'video';

interface UploadCategoryRule {
  mimeTypes: string[];
  label: string;
  /** Config key holding the per-category size limit in MB */
  sizeConfigKey: string;
  defaultMaxSizeMb: number;
}

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** MIME allow-list and size limit per upload category */
const UPLOAD_CATEGORY_RULES: Record<UploadCategory, UploadCategoryRule> = {
  image: {
    mimeTypes: IMAGE_MIME_TYPES,
    label: 'JPEG, PNG, WebP',
    sizeConfigKey: 'MAX_IMAGE_SIZE_MB',
    defaultMaxSizeMb: 10,
  },
  document: {
    mimeTypes: [...IMAGE_MIME_TYPES, 'application/pdf'],
    label: 'JPEG, PNG, WebP, PDF',
    sizeConfigKey: 'MAX_DOCUMENT_SIZE_MB',
    defaultMaxSizeMb: 25,
  },
  kyc: {
    mimeTypes: [...IMAGE_MIME_TYPES, 'application/pdf'],
    label: 'JPEG, PNG, WebP, PDF',
    sizeConfigKey: 'MAX_KYC_FILE_SIZE_MB',
    defaultMaxSizeMb: 10,
  },
  video: {
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'],
    label: 'MP4, MOV, AVI, MKV',
    sizeConfigKey: 'MAX_VIDEO_SIZE_MB',
    defaultMaxSizeMb: 500,
  },
};

/** Global ceiling applied on top of every category limit */
const DEFAULT_MAX_FILE_SIZE_MB = 500;

/** Top-level storage folders that are never served without a valid signature */
export const PRIVATE_UPLOAD_FOLDERS = ['kyc', 'certificates'];

/**
 * Lesson media (videos, transcodes) lives under courses/<courseId>/lessons/
 * and is paid content, so it is private too — served only through
 * short-lived signed URLs issued after enrollment / drip checks (issue #335).
 */
const PRIVATE_LESSON_MEDIA_PATTERN = /^courses\/[^/]+\/lessons\//;

/** Whether a path relative to the upload dir must only be served when signed. */
export function isPrivateUploadPath(relativePath: string): boolean {
  return (
    PRIVATE_UPLOAD_FOLDERS.includes(relativePath.split('/')[0])
    || PRIVATE_LESSON_MEDIA_PATTERN.test(relativePath)
  );
}

export interface StoredFileInfo {
  absolutePath: string;
  /** Path relative to the upload dir, using forward slashes */
  relativePath: string;
  filename: string;
  size: number;
  contentType: string;
  /** Whether the file is safe to render inline in a browser */
  inline: boolean;
  isPrivate: boolean;
}

export interface UploadResult extends MediaDeliveryUrls {
  /** @deprecated Prefer cdnUrl — kept for backward compatibility */
  url: string;
}

export interface VideoUploadResult {
  jobId: string;
  originUrl: string;
  thumbnail: ThumbnailResult;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly uploadDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cdn: CdnService,
    private readonly virusScan: VirusScanService,
    private readonly videoTranscode: VideoTranscodeService,
    private readonly videoThumbnail: VideoThumbnailService,
  ) {
    this.uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');
    this.ensureDir(this.uploadDir);
    this.ensureDir(path.join(this.uploadDir, 'kyc'));
  }

  // ----------------------------------------------------------
  // KYC DOCUMENT UPLOAD
  // ----------------------------------------------------------

  /**
   * Validates and persists a KYC document file.
   * Returns CDN delivery URLs (private signed) plus origin path.
   */
  async saveKycDocument(
    file: Express.Multer.File,
    instructorId: string,
  ): Promise<UploadResult> {
    const { ext } = this.validateFile(file, 'kyc');
    const filename = `kyc-${instructorId}-${uuid()}${ext}`;

    await this.virusScan.scanFile(filename, file.buffer);

    const filePath = path.join(this.uploadDir, 'kyc', filename);

    fs.writeFileSync(filePath, file.buffer);
    this.logger.log(`KYC document saved: ${filePath}`);

    const originUrl = `/uploads/kyc/${filename}`;
    return this.toUploadResult(originUrl, 'private');
  }

  // ----------------------------------------------------------
  // GENERAL FILE UPLOAD (course thumbnails, resources, etc.)
  // ----------------------------------------------------------

  async saveFile(
    file: Express.Multer.File,
    subfolder: string,
    visibility: CdnAssetVisibility = 'public',
    category: UploadCategory = 'image',
  ): Promise<UploadResult> {
    const { ext } = this.validateFile(file, category);

    this.ensureDir(path.join(this.uploadDir, subfolder));

    const filename = `${uuid()}${ext}`;

    await this.virusScan.scanFile(filename, file.buffer);

    const filePath = path.join(this.uploadDir, subfolder, filename);

    fs.writeFileSync(filePath, file.buffer);
    this.logger.log(`File saved: ${filePath}`);

    const originUrl = `/uploads/${subfolder}/${filename}`;
    return this.toUploadResult(originUrl, visibility);
  }

  // ----------------------------------------------------------
  // SERVER-GENERATED FILES (certificate PDFs, etc.) — issue #245
  // ----------------------------------------------------------

  /**
   * Persists a server-generated buffer under a deterministic filename.
   * Defaults to private visibility — callers stream it back through an
   * authorised endpoint via readStoredFile().
   */
  async saveBuffer(
    buffer: Buffer,
    subfolder: string,
    filename: string,
    visibility: CdnAssetVisibility = 'private',
  ): Promise<UploadResult> {
    this.ensureDir(path.join(this.uploadDir, subfolder));

    const safeName = path.basename(filename);
    const filePath = path.join(this.uploadDir, subfolder, safeName);

    fs.writeFileSync(filePath, buffer);
    this.logger.log(`Generated file saved: ${filePath}`);

    const originUrl = `/uploads/${subfolder}/${safeName}`;
    return this.toUploadResult(originUrl, visibility);
  }

  /**
   * Reads a stored file by its origin path (e.g. /uploads/certificates/x.pdf).
   * Returns null when the file does not exist; rejects paths that escape the
   * upload directory.
   */
  readStoredFile(originPath: string): Buffer | null {
    const filePath = this.resolveStoragePath(originPath);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  }

  /**
   * Looks up a stored file for serving (issue #282). Returns null when the
   * file does not exist; rejects paths that escape the upload directory.
   * The Content-Type is derived from a fixed allow-list — unknown types are
   * flagged as non-inline so they are only ever served as downloads.
   */
  getStoredFileInfo(originPath: string): StoredFileInfo | null {
    const absolutePath = this.resolveStoragePath(originPath);
    if (!fs.existsSync(absolutePath)) return null;

    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) return null;

    const { relativePath, isPrivate } = this.describeStoragePath(originPath);
    const ext = path.extname(absolutePath).toLowerCase();
    const inlineType = INLINE_CONTENT_TYPES[ext];

    return {
      absolutePath,
      relativePath,
      filename: path.basename(absolutePath),
      size: stats.size,
      contentType: inlineType ?? 'application/octet-stream',
      inline: Boolean(inlineType),
      isPrivate,
    };
  }

  /**
   * Normalises an origin path (resolving any `..` segments) and reports
   * whether it lives in a private folder that must never be served publicly.
   */
  describeStoragePath(originPath: string): {
    originPath: string;
    relativePath: string;
    isPrivate: boolean;
  } {
    const root = path.resolve(this.uploadDir);
    const absolutePath = this.resolveStoragePath(originPath);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');

    return {
      originPath: `/uploads/${relativePath}`,
      relativePath,
      isPrivate: isPrivateUploadPath(relativePath),
    };
  }

  // ----------------------------------------------------------
  // VIDEO UPLOAD AND TRANSCODING
  // ----------------------------------------------------------

  /**
   * Saves a video file to disk, kicks off transcoding, and auto-generates
   * a thumbnail frame from the video.
   *
   * @param file            Uploaded video file
   * @param subfolder       Storage subfolder (e.g. 'lessons/videos')
   * @param videoId         Lesson or video ID — used for job and thumbnail naming
   * @param thumbnailAtSecs Frame timestamp for thumbnail extraction (default: 5 s)
   */
  async saveVideo(
    file: Express.Multer.File,
    subfolder: string,
    videoId: string,
    thumbnailAtSecs: number = 5,
  ): Promise<VideoUploadResult> {
    if (!file) throw new BadRequestException('No file provided');
    this.videoTranscode.validateVideoFormat(file.mimetype);
    const { ext } = this.validateFile(file, 'video');

    this.ensureDir(path.join(this.uploadDir, subfolder));

    const filename = `${uuid()}${ext}`;

    await this.virusScan.scanFile(filename, file.buffer);

    const filePath = path.join(this.uploadDir, subfolder, filename);
    fs.writeFileSync(filePath, file.buffer);
    this.logger.log(`Video saved: ${filePath}`);

    // Kick off background transcode job
    const jobId = await this.videoTranscode.addTranscodeJob({
      videoId,
      sourcePath: filePath,
      filename,
      subfolder,
    });

    // Auto-generate thumbnail from the saved video file
    const thumbnail = await this.videoThumbnail.extractThumbnail(
      filePath,
      videoId,
      thumbnailAtSecs,
    );

    // Stored as an origin path only — lesson media is private (issue #335), so
    // students get a short-lived signed URL from GET /lessons/:id instead.
    const originUrl = `/uploads/${subfolder}/${filename}`;
    return { jobId, originUrl, thumbnail };
  }

  /**
   * Convert a stored origin path into a full CDN-aware media response.
   */
  getDeliveryUrls(
    originPath: string,
    visibility: CdnAssetVisibility = 'public',
    expiresInSeconds?: number,
  ): UploadResult {
    return this.toUploadResult(originPath, visibility, expiresInSeconds);
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private toUploadResult(
    originPath: string,
    visibility: CdnAssetVisibility,
    expiresInSeconds?: number,
  ): UploadResult {
    // expiresInSeconds only applies to private assets; undefined → CDN default TTL.
    const delivery = this.cdn.attachCdnUrls(originPath, { visibility, expiresInSeconds });
    return {
      ...delivery,
      url: delivery.cdnUrl,
    };
  }

  /**
   * Validates an upload against its category's MIME allow-list and size
   * limit, then sniffs the real type from the file's magic bytes. Returns the
   * detected type so callers derive the stored extension from the content,
   * never from the client-supplied filename.
   */
  validateFile(
    file: Express.Multer.File,
    category: UploadCategory = 'kyc',
  ): DetectedFileType {
    if (!file) throw new BadRequestException('No file provided');

    const rule = UPLOAD_CATEGORY_RULES[category];
    const maxSizeMb = this.getMaxSizeMb(category);
    const size = file.size ?? file.buffer?.length ?? 0;

    if (size > maxSizeMb * 1024 * 1024) {
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${maxSizeMb} MB`,
      );
    }

    if (!rule.mimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `File type "${file.mimetype}" is not allowed. Accepted types: ${rule.label}`,
      );
    }

    const detected = detectFileType(file.buffer);
    if (!detected || !rule.mimeTypes.includes(detected.mime)) {
      throw new BadRequestException(
        `File content does not match an allowed type. Accepted types: ${rule.label}`,
      );
    }

    return detected;
  }

  private getMaxSizeMb(category: UploadCategory): number {
    const rule = UPLOAD_CATEGORY_RULES[category];
    const globalMaxMb = getNumberConfig(this.config, 'MAX_FILE_SIZE_MB', DEFAULT_MAX_FILE_SIZE_MB);
    const categoryMaxMb = getNumberConfig(this.config, rule.sizeConfigKey, rule.defaultMaxSizeMb);
    return Math.min(globalMaxMb, categoryMaxMb);
  }

  private resolveStoragePath(originPath: string): string {
    const root = path.resolve(this.uploadDir);
    const relative = originPath.replace(/^\/?uploads\//, '');
    const filePath = path.resolve(root, relative);

    if (!filePath.startsWith(root + path.sep)) {
      throw new BadRequestException('Invalid storage path');
    }
    return filePath;
  }

  private ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
