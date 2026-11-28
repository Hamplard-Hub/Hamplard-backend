import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CERTIFICATE_ISSUANCE_QUEUE } from '../../common/queue/queue.constants';
import { CertificatesService } from './certificates.service';

@Processor(CERTIFICATE_ISSUANCE_QUEUE)
export class CertificateIssuanceProcessor extends WorkerHost {
  private readonly logger = new Logger(CertificateIssuanceProcessor.name);

  constructor(private readonly certificatesService: CertificatesService) {
    super();
  }

  async process(job: Job<{ studentId: string; courseId: string }>): Promise<any> {
    const { studentId, courseId } = job.data;
    this.logger.log(`Processing certificate issuance job ${job.id} for student ${studentId}, course ${courseId}`);
    return this.certificatesService.issueAutomatic(studentId, courseId);
  }
}
