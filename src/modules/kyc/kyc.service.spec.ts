import { Test, TestingModule } from '@nestjs/testing';
import { KycService } from './kyc.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';

describe('KycService - findMySubmissions pagination', () => {
  let service: KycService;

  const mockPrisma = {
    kycSubmission: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((ops: Promise<any>[]) => Promise.all(ops)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: {} },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    service = module.get<KycService>(KycService);
    jest.clearAllMocks();
  });

  it('returns paginated KYC submissions with meta', async () => {
    mockPrisma.kycSubmission.findMany.mockResolvedValue([{ id: 'kyc-1' }]);
    mockPrisma.kycSubmission.count.mockResolvedValue(3);

    const result = await service.findMySubmissions('inst-1', 2, 2);

    expect(result).toEqual({
      data: [{ id: 'kyc-1' }],
      meta: { total: 3, page: 2, limit: 2, totalPages: 2 },
    });
    expect(mockPrisma.kycSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instructorId: 'inst-1' },
        orderBy: { createdAt: 'desc' },
        skip: 2,
        take: 2,
      }),
    );
  });
});
