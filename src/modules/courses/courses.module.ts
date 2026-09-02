import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { CourseAutosaveController } from './course-autosave.controller';
import { CourseAutosaveService } from './course-autosave.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeeCalculatorModule } from '../billing/fee-calculator.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [NotificationsModule, FeeCalculatorModule, SearchModule],
  controllers: [SearchController, CourseAutosaveController, CoursesController, RecommendationsController],
  providers: [CoursesService, CourseAutosaveService, RecommendationsService, SearchService],
  exports: [CoursesService, CourseAutosaveService, RecommendationsService, SearchService],
})
export class CoursesModule {}