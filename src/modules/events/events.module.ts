// events.module.ts
import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { CoursesModule } from '../courses/courses.module';

@Module({
  imports: [NotificationsModule, EnrollmentsModule, CoursesModule],
  providers: [EventsService],
  controllers: [EventsController],
})
export class EventsModule {}
