// reports.module.ts
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { EngagementReportController } from './engagement-report.controller';
import { EngagementReportService } from './engagement-report.service';

@Module({
  controllers: [ReportsController, EngagementReportController],
  providers: [ReportsService, EngagementReportService],
  exports: [ReportsService, EngagementReportService],
})
export class ReportsModule {}
