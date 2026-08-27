import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';

@Module({
  imports: [ConfigModule],
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService], // Exported for other modules to use createEntry
})
export class AuditLogModule {}
