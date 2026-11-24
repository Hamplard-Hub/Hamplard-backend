import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import * as ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { getBooleanConfig } from '../../common/config/env.util';
import { CdnService } from './cdn.service';
import type { UploadResult } from './uploads.service';

export interface TranscodeJobData {
  videoId: string;
  sourcePath: string;
  filename: string;
  subfolder: string;
}

export const TRANSCODE_QUEUE = 'video-transcode';

const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];

export interface ResolutionPreset {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '4000k' },
  { name: '720p', width: 1280, height: 720, videoBitrate: '2500k' },
  { name: '480p', width: 854, height: 480, videoBitrate: '1000k' },
];

/** A transcoded rendition as persisted on `Lesson.videoRenditions`. */
export interface VideoRendition extends UploadResult {
  width: number;
  height: number;
  videoBitrate: string;
}

/**
 * Picks the presets that do not exceed the source resolution so small
 * sources are never upscaled. When the source is smaller than every preset,
 * a single rendition at the source's own (even-rounded) size is produced.
 * An unknown source size keeps the full preset ladder.
 */
export function selectPresetsForSource(
  source: { width?: number; height?: number } | null,
  presets: ResolutionPreset[] = RESOLUTION_PRESETS,
): ResolutionPreset[] {
  const height = source?.height;
  if (!height || height <= 0) return presets;

  const fitting = presets.filter((preset) => preset.height <= height);
  if (fitting.length) return fitting;

  const evenHeight = Math.max(2, height - (height % 2));
  const width = source?.width && source.width > 0 ? source.width : Math.round((evenHeight * 16) / 9);
  const evenWidth = Math.max(2, width - (width % 2));
  const smallest = presets[presets.length - 1];
  return [{ name: `${evenHeight}p`, width: evenWidth, height: evenHeight, videoBitrate: smallest.videoBitrate }];
}

@Injectable()
export class VideoTranscodeService {
  private readonly logger = new Logger(VideoTranscodeService.name);

  constructor(
    @InjectQueue(TRANSCODE_QUEUE) private readonly transcodeQueue: Queue,
  ) {}

  validateVideoFormat(mimetype: string) {
    if (!VIDEO_MIME_TYPES.includes(mimetype)) {
      throw new BadRequestException(`Video format ${mimetype} is not supported.`);
    }
  }

  async addTranscodeJob(data: TranscodeJobData): Promise<string> {
    const job = await this.transcodeQueue.add('transcode', data);
    this.logger.log(`Added transcode job ${job.id} for video ${data.videoId}`);
    return job.id as string;
  }

  async getJobStatus(jobId: string) {
    const job = await this.transcodeQueue.getJob(jobId);
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      progress: job.progress,
      status: await job.getState(),
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }
}

@Processor(TRANSCODE_QUEUE)
export class VideoTranscodeProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoTranscodeProcessor.name);
  private readonly uploadDir: string;
  private readonly deleteSourceAfterTranscode: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly cdnService: CdnService,
    private readonly prisma: PrismaService,
  ) {
    super();
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', './uploads');
    this.deleteSourceAfterTranscode = getBooleanConfig(
      this.configService,
      'VIDEO_DELETE_SOURCE_AFTER_TRANSCODE',
      false,
    );
  }

  async process(job: Job<TranscodeJobData, any, string>): Promise<any> {
    this.logger.log(`Processing transcode job ${job.id} for video ${job.data.videoId}`);
    const { videoId, sourcePath, filename, subfolder } = job.data;

    const outputUrls: Record<string, VideoRendition> = {};
    const baseFilename = path.parse(filename).name;

    // Issue #336 — never upscale: only transcode presets up to the source resolution
    const sourceSize = await this.probeSourceSize(sourcePath);
    const presets = selectPresetsForSource(sourceSize);

    for (const [index, preset] of presets.entries()) {
      const outputFilename = `${baseFilename}-${preset.name}.mp4`;
      const outputSubfolder = path.join(subfolder, 'transcoded');
      const outputDir = path.join(this.uploadDir, outputSubfolder);
      
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const outputPath = path.join(outputDir, outputFilename);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(sourcePath)
          .outputOptions([
            `-vf scale=${preset.width}x${preset.height}`,
            `-b:v ${preset.videoBitrate}`,
            '-c:v libx264',
            '-c:a aac',
            '-movflags +faststart'
          ])
          .output(outputPath)
          .on('progress', async (progress) => {
            const overallProgress = Math.round(((index + (progress.percent || 0) / 100) / presets.length) * 100);
            await job.updateProgress(overallProgress);
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      const originUrl = `/uploads/${outputSubfolder.replace(/\\/g, '/')}/${outputFilename}`;
      const delivery = this.cdnService.attachCdnUrls(originUrl, { visibility: 'public' });
      outputUrls[preset.name] = {
        ...delivery,
        url: delivery.cdnUrl,
        width: preset.width,
        height: preset.height,
        videoBitrate: preset.videoBitrate,
      };
    }

    // Issue #336 — link the renditions to the lesson so clients can read them
    const sourceOriginUrl = `/uploads/${subfolder.replace(/\\/g, '/')}/${filename}`;
    const linked = await this.linkRenditionsToLesson(videoId, outputUrls, presets, sourceOriginUrl);

    if (linked && this.deleteSourceAfterTranscode) {
      this.deleteSource(sourcePath);
    }

    await job.updateProgress(100);
    this.logger.log(`Completed transcode job ${job.id}`);
    
    return outputUrls;
  }

  /** Reads the source video's dimensions with ffprobe; null when unavailable. */
  private probeSourceSize(sourcePath: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(sourcePath, (err, metadata) => {
        if (err) {
          this.logger.warn(`ffprobe failed for ${sourcePath}: ${err.message}; using all presets`);
          return resolve(null);
        }
        const stream = metadata?.streams?.find((s) => s.codec_type === 'video');
        if (!stream?.width || !stream?.height) return resolve(null);

        // Rotated phone videos report landscape dimensions with a 90° rotation tag
        const rotation = Math.abs(Number((stream as any).tags?.rotate ?? 0)) % 180;
        resolve(
          rotation === 90
            ? { width: stream.height, height: stream.width }
            : { width: stream.width, height: stream.height },
        );
      });
    });
  }

  /**
   * Persists the renditions on the lesson. When the lesson's videoUrl still
   * points at the original upload (or is empty) it is switched to the highest
   * rendition, so deleting the source never leaves a dangling URL.
   * Returns false when no lesson matches the job's videoId.
   */
  private async linkRenditionsToLesson(
    lessonId: string,
    renditions: Record<string, VideoRendition>,
    presets: ResolutionPreset[],
    sourceOriginUrl: string,
  ): Promise<boolean> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, videoUrl: true },
    });
    if (!lesson) {
      this.logger.warn(`Transcode finished for ${lessonId} but no lesson matches; renditions not linked`);
      return false;
    }

    const best = renditions[presets[0].name];
    const pointsAtSource =
      !lesson.videoUrl ||
      lesson.videoUrl === sourceOriginUrl ||
      lesson.videoUrl.endsWith(sourceOriginUrl);

    await this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        videoRenditions: renditions as unknown as Prisma.InputJsonValue,
        ...(pointsAtSource && best ? { videoUrl: best.originUrl } : {}),
      },
    });
    this.logger.log(`Linked ${Object.keys(renditions).length} renditions to lesson ${lessonId}`);
    return true;
  }

  private deleteSource(sourcePath: string) {
    try {
      fs.unlinkSync(sourcePath);
      this.logger.log(`Deleted transcoded source ${sourcePath}`);
    } catch (err) {
      this.logger.warn(`Failed to delete source ${sourcePath}: ${(err as Error).message}`);
    }
  }
}
