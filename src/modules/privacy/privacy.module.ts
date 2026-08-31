import { Module } from '@nestjs/common';
import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

@Module({
  controllers: [DataExportController],
  providers: [DataExportService],
  exports: [DataExportService],
})
export class PrivacyModule {}
