import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { EnrollmentRestoreController } from './enrollment-restore.controller';
import { EnrollmentRestoreService } from './enrollment-restore.service';
import { RestoreController } from './restore.controller';
import { RestoreService } from './restore.service';

@Module({
  imports: [EnrollmentsModule],
  controllers: [EnrollmentRestoreController, RestoreController],
  providers: [EnrollmentRestoreService, RestoreService],
  exports: [EnrollmentRestoreService, RestoreService],
})
export class BackupsModule {}
