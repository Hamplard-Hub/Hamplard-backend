import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import * as ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from '@nestjs/config';
import { CdnService, UploadResult } from './cdn.service';

export interface TranscodeJobData {
  videoId: string;
  sourcePath: string;
  filename: string;
  subfolder: string;
}

export const TRANSCODE_QUEUE = 'video-transcode';

const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];

const RESOLUTION_PRESETS = [
  { name: '1080p', size: '1920x1080', videoBitrate: '4000k' },
  { name: '720p', size: '1280x720', videoBitrate: '2500k' },
  { name: '480p', size: '854x480', videoBitrate: '1000k' },
];

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

  constructor(
    private readonly configService: ConfigService,
    private readonly cdnService: CdnService,
  ) {
    super();
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', './uploads');
  }

  async process(job: Job<TranscodeJobData, any, string>): Promise<any> {
    this.logger.log(`Processing transcode job ${job.id} for video ${job.data.videoId}`);
    const { sourcePath, filename, subfolder } = job.data;
    
    const outputUrls: Record<string, UploadResult> = {};
    const baseFilename = path.parse(filename).name;

    for (const [index, preset] of RESOLUTION_PRESETS.entries()) {
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
            `-vf scale=${preset.size}`,
            `-b:v ${preset.videoBitrate}`,
            '-c:v libx264',
            '-c:a aac',
            '-movflags +faststart'
          ])
          .output(outputPath)
          .on('progress', async (progress) => {
            const overallProgress = Math.round(((index + (progress.percent || 0) / 100) / RESOLUTION_PRESETS.length) * 100);
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
        url: delivery.cdnUrl
      };
    }
    
    await job.updateProgress(100);
    this.logger.log(`Completed transcode job ${job.id}`);
    
    return outputUrls;
  }
}
