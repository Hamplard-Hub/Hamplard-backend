import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { CdnService } from './cdn.service';
import { CdnController } from './cdn.controller';
import { FilesController } from './files.controller';
import { VirusScanService } from './virus-scan.service';
import { VideoTranscodeService, VideoTranscodeProcessor, TRANSCODE_QUEUE } from './video-transcode.service';
import { VideoThumbnailService } from './video-thumbnail.service';
import { StorageFactory, STORAGE_DRIVER } from './storage';

@Module({
  imports: [
    BullModule.registerQueue({
      name: TRANSCODE_QUEUE,
    }),
  ],
  // FilesController must stay last: its GET uploads/* wildcard would
  // otherwise shadow UploadsController's GET routes.
  controllers: [CdnController, UploadsController, FilesController],
  providers: [
    StorageFactory,
    {
      provide: STORAGE_DRIVER,
      useFactory: (storageFactory: StorageFactory) => {
        return storageFactory.createStorageDriver();
      },
      inject: [StorageFactory],
    },
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
export class UploadsModule { }
