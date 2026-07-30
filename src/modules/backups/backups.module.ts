import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { DB_BACKUP_S3_CLIENT } from './backups.constants';
import { DbBackupService } from './db-backup.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DB_BACKUP_S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const endpoint = config.get<string>('BACKUP_S3_ENDPOINT');

        return new S3Client({
          region: config.get<string>('AWS_REGION', 'us-east-1'),
          ...(endpoint
            ? {
                endpoint,
                forcePathStyle: true,
              }
            : {}),
        });
      },
    },
    DbBackupService,
  ],
  exports: [DbBackupService],
})
export class BackupsModule {}
