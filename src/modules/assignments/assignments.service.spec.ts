import { Test, TestingModule } from '@nestjs/testing';
import { AssignmentsService } from './assignments.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AssignmentsService - findSubmissionsByStudent pagination', () => {
  let service: AssignmentsService;

  const mockPrisma = {
    assignmentSubmission: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<AssignmentsService>(AssignmentsService);
    jest.clearAllMocks();
  });

  it('returns paginated submissions with meta', async () => {
    mockPrisma.assignmentSubmission.findMany.mockResolvedValue([{ id: 'sub-1' }]);
    mockPrisma.assignmentSubmission.count.mockResolvedValue(15);

    const result = await service.findSubmissionsByStudent('student-1', 2, 5);

    expect(result).toEqual({
      data: [{ id: 'sub-1' }],
      meta: { total: 15, page: 2, limit: 5, totalPages: 3 },
    });
    expect(mockPrisma.assignmentSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: 'student-1' },
        orderBy: { submittedAt: 'desc' },
        skip: 5,
        take: 5,
      }),
    );
  });
});
