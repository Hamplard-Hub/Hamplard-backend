import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { EnrollmentRestoreController } from './enrollment-restore.controller';
import { EnrollmentRestoreService } from './enrollment-restore.service';
import { RestoreController } from './restore.controller';
import { RestoreService } from './restore.service';
import { DB_BACKUP_S3_CLIENT } from './backups.constants';
import { DbBackupService } from './db-backup.service';

@Module({
  imports: [ConfigModule, EnrollmentsModule],
  controllers: [EnrollmentRestoreController, RestoreController],
  providers: [
    EnrollmentRestoreService,
    RestoreService,
    {
      provide: DB_BACKUP_S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const endpoint = config.get<string>('BACKUP_S3_ENDPOINT');

        return new S3Client({
          region: config.get<string>('AWS_REGION', 'us-east-1'),
          ...(endpoint ? { endpoint, forcePathStyle: true } : {})
        });
      }
    },
    DbBackupService
  ],
  exports: [EnrollmentRestoreService, RestoreService, DbBackupService]
})
export class BackupsModule {}
