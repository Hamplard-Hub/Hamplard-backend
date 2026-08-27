import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UploadsService } from './uploads.service';
import { CdnService } from './cdn.service';
import { CdnController } from './cdn.controller';
import { VirusScanService } from './virus-scan.service';
import { VideoTranscodeService, VideoTranscodeProcessor, TRANSCODE_QUEUE } from './video-transcode.service';
import { VideoThumbnailService } from './video-thumbnail.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: TRANSCODE_QUEUE,
    }),
  ],
  controllers: [CdnController],
  providers: [
    UploadsService,
    CdnService,
    VirusScanService,
    VideoTranscodeService,
    VideoTranscodeProcessor,
    VideoThumbnailService,
  ],
  exports: [
    UploadsService,
    CdnService,
    VirusScanService,
    VideoTranscodeService,
    VideoThumbnailService,
  ],
})
export class UploadsModule {}
