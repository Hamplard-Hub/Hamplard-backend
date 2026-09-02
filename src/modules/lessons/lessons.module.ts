import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { DripScheduleService } from './drip-schedule.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    NotificationsModule,
    forwardRef(() => EnrollmentsModule),
  ],
  controllers: [LessonsController],
  providers: [LessonsService, DripScheduleService],
  exports: [LessonsService, DripScheduleService],
})
export class LessonsModule {}
