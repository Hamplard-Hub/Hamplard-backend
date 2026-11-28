import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { AnnouncementsService } from './announcements.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { CourseAutosaveController } from './course-autosave.controller';
import { CourseAutosaveService } from './course-autosave.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeeCalculatorModule } from '../billing/fee-calculator.module';
import { SearchModule } from '../search/search.module';
import { QueueModule } from '../../common/queue/queue.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [NotificationsModule, FeeCalculatorModule, SearchModule, QueueModule, UploadsModule],
  controllers: [SearchController, CourseAutosaveController, CoursesController, RecommendationsController],
  providers: [CoursesService, CourseAutosaveService, RecommendationsService, SearchService, AnnouncementsService],
  exports: [CoursesService, CourseAutosaveService, RecommendationsService, SearchService, AnnouncementsService],
})
export class CoursesModule {}