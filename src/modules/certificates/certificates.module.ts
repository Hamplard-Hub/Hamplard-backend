import { Module } from '@nestjs/common';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { CertificateTemplatesController } from './certificate-templates.controller';
import { CertificateTemplatesService } from './certificate-templates.service';
import { CertificatePdfService } from './certificate-pdf.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExamsModule } from '../exams/exams.module';
import { CertificateShareController } from './certificate-share.controller';
import { CertificateShareService } from './certificate-share.service';

@Module({
  imports: [NotificationsModule, ExamsModule],
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
  ],
  exports: [
    CertificatesService,
    CertificateTemplatesService,
    CertificatePdfService,
    CertificateShareService,
  ],
})
export class CertificatesModule {}
