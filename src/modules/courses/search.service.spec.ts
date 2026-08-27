import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      course: { findMany: jest.fn() },
      courseSearchTerm: { upsert: jest.fn(), findMany: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [SearchService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(SearchService);
  });

  it('rejects queries shorter than the minimum length', async () => {
    await expect(service.autocomplete('a')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.courseSearchTerm.upsert).not.toHaveBeenCalled();
  });

  it('tracks valid search terms and returns ranked, limited suggestions', async () => {
    prisma.courseSearchTerm.upsert.mockResolvedValue(undefined);
    prisma.courseSearchTerm.findMany.mockResolvedValue([{ term: 'baking', searchCount: 7 }]);
    prisma.course.findMany.mockResolvedValue([
      { id: 'course-1', title: 'Baking Basics', category: 'Baking', totalEnrollments: 15, avgRating: 4.8 },
      { id: 'course-2', title: 'Advanced Cake Baking', category: 'Culinary', totalEnrollments: 3, avgRating: 4.5 },
    ]);

    const result = await service.autocomplete('  Ba  ', 2);

    expect(prisma.courseSearchTerm.upsert).toHaveBeenCalledWith({
      where: { term: 'ba' },
      create: { term: 'ba', searchCount: 1 },
      update: { searchCount: { increment: 1 }, lastSearchedAt: expect.any(Date) },
    });
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ text: 'Baking Basics', type: 'course', courseId: 'course-1' });
    expect(result.meta).toMatchObject({ query: 'ba', limit: 2, minQueryLength: 2, total: 2 });
  });
});
