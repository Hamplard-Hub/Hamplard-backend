import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportTargetType } from '@prisma/client';

describe('ReportsService (Issue #171) — COMMENT target validation', () => {
  let service: ReportsService;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    course: { findUnique: jest.fn() },
    discussionComment: { findUnique: jest.fn() },
    abuseReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    jest.clearAllMocks();
  });

  it('should return 404 when filing a report against a nonexistent DiscussionComment', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'reporter1' });
    mockPrisma.discussionComment.findUnique.mockResolvedValue(null);
    mockPrisma.abuseReport.findFirst.mockResolvedValue(null);

    await expect(
      service.create('reporter1', {
        targetType: ReportTargetType.COMMENT,
        targetId: 'nonexistent-comment',
        category: 'SPAM' as any,
        description: 'test',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should succeed when DiscussionComment exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'reporter1' });
    mockPrisma.discussionComment.findUnique.mockResolvedValue({ id: 'comment1' });
    mockPrisma.abuseReport.findFirst.mockResolvedValue(null);
    mockPrisma.abuseReport.create.mockResolvedValue({ id: 'report1' });

    const result = await service.create('reporter1', {
      targetType: ReportTargetType.COMMENT,
      targetId: 'comment1',
      category: 'SPAM' as any,
      description: 'test',
    });

    expect(result).toHaveProperty('id', 'report1');
  });
});
