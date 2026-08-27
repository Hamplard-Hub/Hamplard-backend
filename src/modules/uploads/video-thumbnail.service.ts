import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuid } from 'uuid';

/** Minimum allowed frame timestamp in seconds */
const MIN_TIMESTAMP_SECS = 0;
/** Maximum allowed frame timestamp in seconds (10 minutes) */
const MAX_TIMESTAMP_SECS = 600;
/** Default timestamp to extract frame from (5 seconds in) */
const DEFAULT_TIMESTAMP_SECS = 5;
/** Fallback thumbnail filename served when extraction fails */
const FALLBACK_THUMBNAIL_FILENAME = 'fallback-thumbnail.jpg';

export interface ThumbnailResult {
  /** Public URL of the generated (or fallback) thumbnail */
  thumbnailUrl: string;
  /** Absolute filesystem path to the thumbnail file */
  thumbnailPath: string;
  /** Whether this is a fallback thumbnail (extraction failed) */
  isFallback: boolean;
}

@Injectable()
export class VideoThumbnailService {
  private readonly logger = new Logger(VideoThumbnailService.name);
  private readonly uploadDir: string;
  private readonly fallbackThumbnailPath: string;

  constructor(private readonly config: ConfigService) {
    this.uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');
    this.fallbackThumbnailPath = this.config.get<string>(
      'FALLBACK_THUMBNAIL_PATH',
      path.join(this.uploadDir, 'thumbnails', FALLBACK_THUMBNAIL_FILENAME),
    );

    this.ensureDir(path.join(this.uploadDir, 'thumbnails'));
    this.ensureFallbackThumbnail();
  }

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------

  /**
   * Validates a frame timestamp before extraction.
   * Throws BadRequestException if out of range.
   */
  validateTimestamp(timestampSecs: number): void {
    if (
      typeof timestampSecs !== 'number' ||
      isNaN(timestampSecs) ||
      timestampSecs < MIN_TIMESTAMP_SECS ||
      timestampSecs > MAX_TIMESTAMP_SECS
    ) {
      throw new BadRequestException(
        `Frame timestamp must be between ${MIN_TIMESTAMP_SECS} and ${MAX_TIMESTAMP_SECS} seconds.`,
      );
    }
  }

  /**
   * Extracts a thumbnail frame from a video at the given timestamp.
   * Falls back to a default thumbnail image if extraction fails.
   *
   * @param videoPath   Absolute path to the source video file
   * @param lessonId    Used to build a deterministic output filename
   * @param timestampSecs  Frame timestamp in seconds (default: 5)
   */
  async extractThumbnail(
    videoPath: string,
    lessonId: string,
    timestampSecs: number = DEFAULT_TIMESTAMP_SECS,
  ): Promise<ThumbnailResult> {
    this.validateTimestamp(timestampSecs);

    const thumbDir = path.join(this.uploadDir, 'thumbnails');
    this.ensureDir(thumbDir);

    const filename = `thumb-${lessonId}-${uuid()}.jpg`;
    const outputPath = path.join(thumbDir, filename);

    try {
      await this.runFfmpegExtraction(videoPath, outputPath, timestampSecs);
      this.logger.log(
        `Thumbnail extracted for lesson ${lessonId} at ${timestampSecs}s → ${outputPath}`,
      );

      const thumbnailUrl = `/uploads/thumbnails/${filename}`;
      return { thumbnailUrl, thumbnailPath: outputPath, isFallback: false };
    } catch (err) {
      this.logger.warn(
        `Thumbnail extraction failed for lesson ${lessonId}: ${(err as Error).message}. Using fallback.`,
      );
      return this.buildFallbackResult();
    }
  }

  /**
   * Returns the public thumbnail URL for a lesson.
   * If storedThumbnailUrl is already set, returns it as-is.
   * Otherwise falls back to the default thumbnail.
   */
  resolveThumbnailUrl(storedThumbnailUrl: string | null | undefined): string {
    if (storedThumbnailUrl && storedThumbnailUrl.trim().length > 0) {
      return storedThumbnailUrl;
    }
    return this.getFallbackUrl();
  }

  /**
   * Removes a previously generated thumbnail from disk.
   * Silently ignores missing files and the fallback thumbnail.
   */
  deleteThumbnail(thumbnailPath: string): void {
    if (
      !thumbnailPath ||
      thumbnailPath === this.fallbackThumbnailPath ||
      !fs.existsSync(thumbnailPath)
    ) {
      return;
    }
    try {
      fs.unlinkSync(thumbnailPath);
      this.logger.log(`Thumbnail deleted: ${thumbnailPath}`);
    } catch (err) {
      this.logger.warn(`Could not delete thumbnail ${thumbnailPath}: ${(err as Error).message}`);
    }
  }

  // ----------------------------------------------------------
  // PRIVATE HELPERS
  // ----------------------------------------------------------

  /**
   * Runs ffmpeg to extract a single JPEG frame from the video.
   */
  private runFfmpegExtraction(
    videoPath: string,
    outputPath: string,
    timestampSecs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestampSecs)
        .frames(1)
        .outputOptions(['-q:v 2', '-f image2'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Builds a ThumbnailResult pointing at the fallback image.
   */
  private buildFallbackResult(): ThumbnailResult {
    return {
      thumbnailUrl: this.getFallbackUrl(),
      thumbnailPath: this.fallbackThumbnailPath,
      isFallback: true,
    };
  }

  private getFallbackUrl(): string {
    return `/uploads/thumbnails/${FALLBACK_THUMBNAIL_FILENAME}`;
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Writes a minimal placeholder JPEG as the fallback thumbnail if it
   * doesn't already exist. This prevents 404s when extraction fails.
   *
   * The file is a 1×1 transparent JPEG — just enough to be a valid image.
   * In production you'd ship a proper branded placeholder asset instead.
   */
  private ensureFallbackThumbnail(): void {
    if (fs.existsSync(this.fallbackThumbnailPath)) return;

    try {
      // Minimal valid JPEG (1×1 grey pixel)
      const minimalJpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
          'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
          'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
          'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB' +
          'AAAAAMAAAAAAAAAAAAAAAAAAAD/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAA' +
          'AAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABmX' +
          '/9k=',
        'base64',
      );
      fs.writeFileSync(this.fallbackThumbnailPath, minimalJpeg);
      this.logger.log(`Fallback thumbnail written to ${this.fallbackThumbnailPath}`);
    } catch (err) {
      this.logger.warn(`Could not write fallback thumbnail: ${(err as Error).message}`);
    }
  }
}
