import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { VirusScanService } from './virus-scan.service';

jest.mock('clamscan', () => {
  return jest.fn().mockImplementation(() => {
    return {
      init: jest.fn().mockResolvedValue({
        scanBuffer: jest.fn(),
      }),
    };
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeClam = require('clamscan');

describe('VirusScanService', () => {
  let service: VirusScanService;
  let mockScanBuffer: jest.Mock;

  const mockConfigGet = jest.fn((key: string, defaultValue?: unknown) => {
    const configMap: Record<string, any> = {
      VIRUS_SCAN_ENABLED: true,
      VIRUS_SCAN_MAX_RETRIES: 2,
    };
    return configMap[key] !== undefined ? configMap[key] : defaultValue;
  });

  let mockPrisma: any;
  let scanRecords: any[];

  beforeEach(async () => {
    mockScanBuffer = jest.fn();
    scanRecords = [];
    mockPrisma = {
      fileScanResult: {
        upsert: jest.fn().mockImplementation(({ where, update, create }) => {
          const idx = scanRecords.findIndex((r) => r.fileId === where.fileId);
          if (idx !== -1) {
            scanRecords[idx] = { ...scanRecords[idx], ...update };
            return Promise.resolve(scanRecords[idx]);
          }
          const rec = { ...create };
          scanRecords.push(rec);
          return Promise.resolve(rec);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = scanRecords.findIndex((r) => r.fileId === where.fileId);
          if (idx !== -1) {
            scanRecords[idx] = { ...scanRecords[idx], ...data };
            return Promise.resolve(scanRecords[idx]);
          }
          return Promise.resolve(data);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          const rec = scanRecords.find((r) => r.fileId === where.fileId);
          return Promise.resolve(rec || null);
        }),
      },
    };

    NodeClam.mockImplementation(() => ({
      init: jest.fn().mockResolvedValue({
        scanBuffer: mockScanBuffer,
      }),
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VirusScanService,
        {
          provide: ConfigService,
          useValue: { get: mockConfigGet },
        },
        {
          provide: require('../../common/prisma/prisma.service').PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<VirusScanService>(VirusScanService);
    await service.onModuleInit();
    jest.clearAllMocks();
  });

  it('bypasses scan and tracks clean status if service is disabled', async () => {
    mockConfigGet.mockReturnValueOnce(false);
    await service.onModuleInit();

    const buffer = Buffer.from('test data');
    await service.scanFile('file-1', buffer);

    const status = await service.getScanStatus('file-1');
    expect(status?.status).toBe('clean');
    expect(status?.details).toBe('Scanner bypassed');
  });

  it('scans a clean file successfully', async () => {
    mockScanBuffer.mockResolvedValueOnce({ isInfected: false, viruses: [] });

    await service.scanFile('file-2', Buffer.from('safe content'));

    const status = await service.getScanStatus('file-2');
    expect(status?.status).toBe('clean');
    expect(status?.attempts).toBe(1);
  });

  it('throws BadRequestException and marks infected when malware is detected', async () => {
    mockScanBuffer.mockResolvedValueOnce({
      isInfected: true,
      viruses: ['EICAR-Test-Signature'],
    });

    await expect(service.scanFile('file-3', Buffer.from('infected'))).rejects.toThrow(
      BadRequestException,
    );

    const status = await service.getScanStatus('file-3');
    expect(status?.status).toBe('infected');
    expect(status?.details).toContain('EICAR-Test-Signature');
  });

  it('retries on timeout and marks error if max retries exceeded', async () => {
    mockScanBuffer.mockRejectedValue(new Error('timeout'));

    await expect(service.scanFile('file-4', Buffer.from('data'))).rejects.toThrow(
      BadRequestException,
    );

    const status = await service.getScanStatus('file-4');
    expect(status?.status).toBe('error');
    expect(status?.attempts).toBe(2);
  });

  it('succeeds if timeout happens but subsequent retry passes', async () => {
    mockScanBuffer
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ isInfected: false, viruses: [] });

    await service.scanFile('file-5', Buffer.from('data'));

    const status = await service.getScanStatus('file-5');
    expect(status?.status).toBe('clean');
    expect(status?.attempts).toBe(2);
  });
});
