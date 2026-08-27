// reports.module.ts
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { InstructorReportController } from './instructor-report.controller';
import { InstructorReportService } from './instructor-report.service';

@Module({
  controllers: [ReportsController, InstructorReportController],
  providers: [ReportsService, InstructorReportService],
  exports: [ReportsService, InstructorReportService],
})
export class ReportsModule {}
