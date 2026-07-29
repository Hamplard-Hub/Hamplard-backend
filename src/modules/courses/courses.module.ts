import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeeCalculatorModule } from '../billing/fee-calculator.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [NotificationsModule, FeeCalculatorModule, SearchModule],
  controllers: [CoursesController, RecommendationsController],
  providers: [CoursesService, RecommendationsService],
  exports: [CoursesService, RecommendationsService],
})
export class CoursesModule {}
