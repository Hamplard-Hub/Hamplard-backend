import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DATA_EXPORT_QUEUE } from '../../common/queue/queue.constants';
import { DataExportJobData } from '../../common/queue/queue.service';
import { DataExportService } from './data-export.service';

@Processor(DATA_EXPORT_QUEUE)
export class DataExportProcessor extends WorkerHost {
  constructor(private readonly dataExportService: DataExportService) {
    super();
  }

  async process(job: Job<DataExportJobData>) {
    await this.dataExportService.processExport(job.data.jobId);
    return { processed: true };
  }
}
