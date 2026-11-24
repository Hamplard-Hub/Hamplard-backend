import { Test, TestingModule } from '@nestjs/testing';
import { CertificatesService } from './certificates.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CoursesService } from '../courses/courses.service';

describe('CertificatesService - findByStudent pagination', () => {
  let service: CertificatesService;

  const mockPrisma = {
    certificate: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CoursesService, useValue: {} },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<CertificatesService>(CertificatesService);
    jest.clearAllMocks();
  });

  it('returns paginated certificates with meta', async () => {
    mockPrisma.certificate.findMany.mockResolvedValue([{ id: 'cert-1' }]);
    mockPrisma.certificate.count.mockResolvedValue(25);

    const result = await service.findByStudent('student-1', 2, 10);

    expect(result).toEqual({
      data: [{ id: 'cert-1' }],
      meta: { total: 25, page: 2, limit: 10, totalPages: 3 },
    });
    expect(mockPrisma.certificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: 'student-1' },
        orderBy: { issuedAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
  });

  it('clamps page and limit to valid bounds', async () => {
    mockPrisma.certificate.findMany.mockResolvedValue([]);
    mockPrisma.certificate.count.mockResolvedValue(0);

    const result = await service.findByStudent('student-1', -1, 500);

    expect(result.meta).toEqual({ total: 0, page: 1, limit: 100, totalPages: 0 });
    expect(mockPrisma.certificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });
});
