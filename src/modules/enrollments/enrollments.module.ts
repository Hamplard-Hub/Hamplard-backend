import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';
import { FraudDetectionService } from './fraud-detection.service';
import { FraudController } from './fraud.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { LessonsModule } from '../lessons/lessons.module';

@Module({
  imports: [
    ConfigModule,
    NotificationsModule,
    InvoicesModule,
    ReferralsModule,
    forwardRef(() => LessonsModule),
  ],
  controllers: [EnrollmentsController, RefundsController, FraudController],
  providers: [EnrollmentsService, RefundsService, FraudDetectionService],
  exports: [EnrollmentsService, RefundsService, FraudDetectionService],
})
export class EnrollmentsModule {}
