// reports.module.ts
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { TopCoursesController } from './top-courses.controller';
import { TopCoursesService } from './top-courses.service';

@Module({
  controllers: [ReportsController, TopCoursesController],
  providers: [ReportsService, TopCoursesService],
  exports: [ReportsService, TopCoursesService],
})
export class ReportsModule {}
