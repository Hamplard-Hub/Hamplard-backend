// reports.module.ts
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { EngagementReportController } from './engagement-report.controller';
import { EngagementReportService } from './engagement-report.service';
import { RevenueReportController } from './revenue-report.controller';
import { RevenueReportService } from './revenue-report.service';
import { TopCoursesController } from './top-courses.controller';
import { TopCoursesService } from './top-courses.service';
import { InstructorReportController } from './instructor-report.controller';
import { InstructorReportService } from './instructor-report.service';
import { InstructorDashboardController } from './instructor-dashboard.controller';
import { InstructorDashboardService } from './instructor-dashboard.service';

@Module({
  controllers: [
    ReportsController,
    EngagementReportController,
    RevenueReportController,
    TopCoursesController,
    InstructorReportController,
    InstructorDashboardController,
  ],
  providers: [
    ReportsService,
    EngagementReportService,
    RevenueReportService,
    TopCoursesService,
    InstructorReportService,
    InstructorDashboardService,
  ],
  exports: [
    ReportsService,
    EngagementReportService,
    RevenueReportService,
    TopCoursesService,
    InstructorReportService,
    InstructorDashboardService,
  ],
})
export class ReportsModule {}
