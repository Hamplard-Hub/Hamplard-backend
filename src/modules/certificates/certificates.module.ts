import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { CertificateTemplatesController } from './certificate-templates.controller';
import { CertificateTemplatesService } from './certificate-templates.service';
import { CertificatePdfService } from './certificate-pdf.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExamsModule } from '../exams/exams.module';
import { CertificateShareController } from './certificate-share.controller';
import { CertificateShareService } from './certificate-share.service';
import { UploadsModule } from '../uploads/uploads.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CERTIFICATE_ISSUANCE_QUEUE } from '../../common/queue/queue.constants';
import { CertificateIssuanceProcessor } from './certificate-issuance.processor';

@Module({
  imports: [
    NotificationsModule,
    ExamsModule,
    UploadsModule,
    AnalyticsModule,
    BullModule.registerQueue({ name: CERTIFICATE_ISSUANCE_QUEUE }),
  ],
  controllers: [
    CertificateTemplatesController,
    CertificateShareController,
    CertificatesController,
  ],
  providers: [
    CertificatesService,
    CertificateTemplatesService,
    CertificatePdfService,
    CertificateShareService,
    CertificateIssuanceProcessor,
  ],
  exports: [
    CertificatesService,
    CertificateTemplatesService,
    CertificatePdfService,
    CertificateShareService,
  ],
})
export class CertificatesModule {}
