import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeClam = require('clamscan');

export type ScanStatus = 'pending' | 'scanning' | 'clean' | 'infected' | 'error';

export interface ScanResult {
  fileId: string;
  status: ScanStatus;
  startedAt: Date;
  completedAt?: Date;
  details?: string;
  attempts: number;
}

@Injectable()
export class VirusScanService implements OnModuleInit {
  private readonly logger = new Logger(VirusScanService.name);
  private clamscan: any;
  private readonly results = new Map<string, ScanResult>();
  private isEnabled = true;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.isEnabled = this.config.get<boolean>('VIRUS_SCAN_ENABLED', true);
    if (!this.isEnabled) {
      this.logger.warn('Virus scanning is disabled via configuration.');
      return;
    }

    try {
      this.clamscan = await new NodeClam().init({
        clamdscan: {
          host: this.config.get<string>('CLAMD_HOST', '127.0.0.1'),
          port: this.config.get<number>('CLAMD_PORT', 3310),
          timeout: this.config.get<number>('CLAMD_TIMEOUT', 5000),
        },
        preference: 'clamdscan',
      });
      this.logger.log('ClamAV scanner initialized successfully.');
    } catch (error) {
      this.logger.error(`Failed to initialize ClamAV: ${error?.message}`);
      this.isEnabled = false;
    }
  }

  async scanFile(fileId: string, buffer: Buffer): Promise<void> {
    const maxRetries = this.config.get<number>('VIRUS_SCAN_MAX_RETRIES', 3);

    const result: ScanResult = {
      fileId,
      status: 'pending',
      startedAt: new Date(),
      attempts: 0,
    };
    this.results.set(fileId, result);

    if (!this.isEnabled || !this.clamscan) {
      this.logger.warn(`Skipping scan for ${fileId}: scanner unavailable`);
      result.status = 'clean';
      result.completedAt = new Date();
      result.details = 'Scanner bypassed';
      this.results.set(fileId, result);
      return;
    }

    result.status = 'scanning';
    this.results.set(fileId, result);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        result.attempts = attempt;

        const { isInfected, viruses } = await this.clamscan.scanBuffer(buffer);

        if (isInfected) {
          result.status = 'infected';
          result.completedAt = new Date();
          result.details = viruses.join(', ');
          this.results.set(fileId, result);

          this.logger.warn(`Malware detected in file ${fileId}: ${result.details}`);
          throw new BadRequestException('Malware detected in uploaded file');
        }

        result.status = 'clean';
        result.completedAt = new Date();
        this.results.set(fileId, result);
        this.logger.log(`File ${fileId} scanned: clean`);
        return;
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }

        this.logger.warn(`Scan attempt ${attempt} failed for ${fileId}: ${error.message}`);

        if (attempt === maxRetries) {
          result.status = 'error';
          result.completedAt = new Date();
          result.details = error.message;
          this.results.set(fileId, result);
          this.logger.error(`Exhausted retries scanning ${fileId}`);
          throw new BadRequestException('File scanning failed due to safety timeout');
        }

        await new Promise((res) => setTimeout(res, Math.pow(2, attempt) * 500));
      }
    }
  }

  getScanStatus(fileId: string): ScanResult | undefined {
    return this.results.get(fileId);
  }
}
