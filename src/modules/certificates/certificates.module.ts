import { Module } from '@nestjs/common';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';
import { CertificateTemplatesController } from './certificate-templates.controller';
import { CertificateTemplatesService } from './certificate-templates.service';
import { CertificatePdfService } from './certificate-pdf.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExamsModule } from '../exams/exams.module';

@Module({
  imports: [NotificationsModule, ExamsModule],
  controllers: [CertificateTemplatesController, CertificatesController],
  providers: [CertificatesService, CertificateTemplatesService, CertificatePdfService],
  exports: [CertificatesService, CertificateTemplatesService, CertificatePdfService],
})
export class CertificatesModule {}
