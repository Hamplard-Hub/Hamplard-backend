import { Test, TestingModule } from '@nestjs/testing';
import { BadgesService } from './badges.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('BadgesService - getCatalog pagination', () => {
  let service: BadgesService;

  const mockPrisma = {
    badge: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BadgesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BadgesService>(BadgesService);
    jest.clearAllMocks();
  });

  it('returns paginated badge catalog with meta', async () => {
    mockPrisma.badge.findMany.mockResolvedValue([{ id: 'badge-1' }]);
    mockPrisma.badge.count.mockResolvedValue(12);

    const result = await service.getCatalog(2, 5);

    expect(result).toEqual({
      data: [{ id: 'badge-1' }],
      meta: { total: 12, page: 2, limit: 5, totalPages: 3 },
    });
    expect(mockPrisma.badge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'asc' },
        skip: 5,
        take: 5,
      }),
    );
  });
});
