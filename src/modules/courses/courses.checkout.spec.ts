import { NotFoundException } from '@nestjs/common';
import { CourseStatus } from '@prisma/client';
import { CoursesService } from './courses.service';
import { FeeCalculatorService } from '../billing/fee-calculator.service';

/**
 * Issue #441 — GET /courses/:id/checkout must not expose unpublished courses.
 *
 * The Prisma mock evaluates the `where` clause against an in-memory table so
 * the test proves the status filter is enforced by the query itself.
 */
describe('CoursesService.getCheckoutBreakdown() (issue #441)', () => {
  const courses = [
    { id: 'C-ACTIVE',   title: 'Live Tailoring',      price: 100, platformFeePercent: 20, status: CourseStatus.ACTIVE },
    { id: 'C-DRAFT',    title: 'Secret Draft Course', price: 999, platformFeePercent: 20, status: CourseStatus.DRAFT },
    { id: 'C-PENDING',  title: 'Awaiting Review',     price: 888, platformFeePercent: 20, status: CourseStatus.PENDING },
    { id: 'C-PAUSED',   title: 'Paused Course',       price: 777, platformFeePercent: 20, status: CourseStatus.PAUSED },
    { id: 'C-ARCHIVED', title: 'Retired Course',      price: 666, platformFeePercent: 20, status: CourseStatus.ARCHIVED },
  ];

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row;

  const prisma = {
    course: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = courses.find((c) => matches(c, where));
        return row ? pick(row, select) : null;
      }),
      findUnique: jest.fn(async ({ where, select }: any) => {
        const row = courses.find((c) => c.id === where.id);
        return row ? pick(row, select) : null;
      }),
    },
    taxRate: {
      findMany: jest.fn().mockResolvedValue([
        { region: 'DEFAULT', ratePercent: 0 },
        { region: 'NG', ratePercent: 7.5 },
      ]),
    },
  };

  let service: CoursesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CoursesService(
      prisma as any,
      {} as any,
      new FeeCalculatorService(prisma as any),
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      {} as any,
    );
  });

  describe('ACTIVE course', () => {
    it('returns the course identity with the default-region breakdown', async () => {
      const result = await service.getCheckoutBreakdown('C-ACTIVE');

      expect(result).toEqual({
        courseId: 'C-ACTIVE',
        courseTitle: 'Live Tailoring',
        currency: 'USDC',
        basePrice: 100,
        platformFeePercent: 20,
        platformFeeAmount: 20,
        instructorPayout: 80,
        region: 'DEFAULT',
        taxRatePercent: 0,
        taxAmount: 0,
        totalPayable: 100,
      });
    });

    it('applies the regional tax rate', async () => {
      const result = await service.getCheckoutBreakdown('C-ACTIVE', 'ng');

      expect(result).toMatchObject({
        region: 'NG',
        taxRatePercent: 7.5,
        taxAmount: 7.5,
        totalPayable: 107.5,
      });
    });

    it('filters on ACTIVE status in the database query', async () => {
      await service.getCheckoutBreakdown('C-ACTIVE');
      expect(prisma.course.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'C-ACTIVE', status: CourseStatus.ACTIVE } }),
      );
      expect(prisma.course.findUnique).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['DRAFT', 'C-DRAFT'],
    ['PENDING', 'C-PENDING'],
    ['PAUSED', 'C-PAUSED'],
    ['ARCHIVED', 'C-ARCHIVED'],
  ])('%s course', (_status, id) => {
    it('returns 404', async () => {
      await expect(service.getCheckoutBreakdown(id)).rejects.toThrow(NotFoundException);
    });

    it('does not disclose title or price in the error', async () => {
      const course = courses.find((c) => c.id === id)!;
      const error = await service.getCheckoutBreakdown(id, 'NG').catch((e) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      const body = JSON.stringify(error.getResponse());
      expect(body).not.toContain(course.title);
      expect(body).not.toContain(String(course.price));
      expect(prisma.taxRate.findMany).not.toHaveBeenCalled();
    });

    it('is indistinguishable from an unknown course id', async () => {
      const unpublished = await service.getCheckoutBreakdown(id).catch((e) => e);
      const unknown = await service.getCheckoutBreakdown('NOPE').catch((e) => e);

      expect(unpublished.getStatus()).toBe(404);
      expect(unpublished.getStatus()).toBe(unknown.getStatus());
      expect(unpublished.getResponse()).toEqual({
        ...unknown.getResponse(),
        message: `Course ${id} not found`,
      });
    });
  });

  it('returns 404 for unknown course ids', async () => {
    await expect(service.getCheckoutBreakdown('DOES-NOT-EXIST')).rejects.toThrow(NotFoundException);
  });
});
