import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';

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
  private isEnabled = true;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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

    await this.prisma.fileScanResult.upsert({
      where: { fileId },
      update: {
        status: 'pending',
        startedAt: new Date(),
        completedAt: null,
        details: null,
        attempts: 0,
      },
      create: {
        fileId,
        status: 'pending',
        startedAt: new Date(),
        attempts: 0,
      },
    });

    if (!this.isEnabled || !this.clamscan) {
      this.logger.warn(`Skipping scan for ${fileId}: scanner unavailable`);
      await this.prisma.fileScanResult.update({
        where: { fileId },
        data: {
          status: 'clean',
          completedAt: new Date(),
          details: 'Scanner bypassed',
        },
      });
      return;
    }

    await this.prisma.fileScanResult.update({
      where: { fileId },
      data: { status: 'scanning' },
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.prisma.fileScanResult.update({
          where: { fileId },
          data: { attempts: attempt },
        });

        const { isInfected, viruses } = await this.clamscan.scanBuffer(buffer);

        if (isInfected) {
          const details = viruses.join(', ');
          await this.prisma.fileScanResult.update({
            where: { fileId },
            data: {
              status: 'infected',
              completedAt: new Date(),
              details,
            },
          });

          this.logger.warn(`Malware detected in file ${fileId}: ${details}`);
          throw new BadRequestException('Malware detected in uploaded file');
        }

        await this.prisma.fileScanResult.update({
          where: { fileId },
          data: {
            status: 'clean',
            completedAt: new Date(),
          },
        });
        this.logger.log(`File ${fileId} scanned: clean`);
        return;
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }

        this.logger.warn(`Scan attempt ${attempt} failed for ${fileId}: ${error.message}`);

        if (attempt === maxRetries) {
          await this.prisma.fileScanResult.update({
            where: { fileId },
            data: {
              status: 'error',
              completedAt: new Date(),
              details: error.message,
            },
          });
          this.logger.error(`Exhausted retries scanning ${fileId}`);
          throw new BadRequestException('File scanning failed due to safety timeout');
        }

        await new Promise((res) => setTimeout(res, Math.pow(2, attempt) * 500));
      }
    }
  }

  async getScanStatus(fileId: string): Promise<ScanResult | undefined> {
    const record = await this.prisma.fileScanResult.findUnique({
      where: { fileId },
    });
    if (!record) return undefined;
    return {
      fileId: record.fileId,
      status: record.status as ScanStatus,
      startedAt: record.startedAt,
      completedAt: record.completedAt ?? undefined,
      details: record.details ?? undefined,
      attempts: record.attempts,
    };
  }
}
