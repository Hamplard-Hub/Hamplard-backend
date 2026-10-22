import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { DataExportProcessor } from './data-export.processor';
import { DATA_EXPORT_QUEUE } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';

@Module({
  imports: [BullModule.registerQueue({ name: DATA_EXPORT_QUEUE }), QueueModule],
  controllers: [DataExportController],
  providers: [DataExportService, DataExportProcessor],
  exports: [DataExportService],
})
export class PrivacyModule {}
