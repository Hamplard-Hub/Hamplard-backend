import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CourseStatus, Prisma } from '@prisma/client';
import { BundlesService } from './bundles.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';

describe('BundlesService', () => {
  let service: BundlesService;

  const courseA = { id: 'course-a', title: 'A', instructorAddress: 'GINST', status: CourseStatus.ACTIVE, price: new Prisma.Decimal(60) };
  const courseB = { id: 'course-b', title: 'B', instructorAddress: 'GINST', status: CourseStatus.ACTIVE, price: new Prisma.Decimal(30) };
  const courseC = { id: 'course-c', title: 'C', instructorAddress: 'GINST', status: CourseStatus.ACTIVE, price: new Prisma.Decimal(10) };

  const bundle = {
    id: 'bundle-1',
    isActive: true,
    price: new Prisma.Decimal('79.99'),
    courses: [{ course: courseA }, { course: courseB }, { course: courseC }],
  };

  const tx = {
    payment: { create: jest.fn() },
    bundleEnrollment: { create: jest.fn() },
    enrollment: { createMany: jest.fn(), findUnique: jest.fn() },
    course: { update: jest.fn() },
  };

  const mockPrisma = {
    bundle: { findUnique: jest.fn() },
    bundleEnrollment: { findUnique: jest.fn() },
    enrollment: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const mockEnrollments = {
    assertCourseActive: jest.fn((course: { status: CourseStatus }) => {
      if (course.status !== CourseStatus.ACTIVE) throw new ForbiddenException();
    }),
    verifyPaymentTransactionBasic: jest.fn(),
    runPreEnrollmentChecks: jest.fn(),
    runPostEnrollmentSteps: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.bundle.findUnique.mockResolvedValue(bundle);
    mockPrisma.bundleEnrollment.findUnique.mockResolvedValue(null);
    mockPrisma.enrollment.findMany.mockResolvedValue([]);
    mockEnrollments.verifyPaymentTransactionBasic.mockResolvedValue(undefined);
    mockEnrollments.runPreEnrollmentChecks.mockResolvedValue({ action: 'ALLOW', score: 0, reasons: [] });
    mockEnrollments.runPostEnrollmentSteps.mockResolvedValue(undefined);

    tx.bundleEnrollment.create.mockResolvedValue({ id: 'be-1' });
    tx.enrollment.createMany.mockResolvedValue({ count: 1 });
    tx.enrollment.findUnique.mockImplementation(({ where }) => {
      const courseId = where.studentId_courseId.courseId;
      const amountPaid = tx.enrollment.createMany.mock.calls
        .map(([args]) => args.data[0])
        .find((d) => d.courseId === courseId).amountPaid;
      return Promise.resolve({ id: `enr-${courseId}`, studentId: 'student-1', courseId, amountPaid, course: { title: courseId, instructorAddress: 'GINST' } });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BundlesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrollmentsService, useValue: mockEnrollments },
      ],
    }).compile();

    service = module.get<BundlesService>(BundlesService);
  });

  describe('allocateBundlePrice', () => {
    it('splits the bundle price pro-rata and sums exactly to the bundle price', () => {
      const allocations = service.allocateBundlePrice(bundle.price, [courseA, courseB, courseC]);

      expect(allocations.get('course-a')!.toString()).toBe('47.99');
      expect(allocations.get('course-b')!.toString()).toBe('23.99');
      expect(allocations.get('course-c')!.toString()).toBe('8.01');

      const sum = [...allocations.values()].reduce((s, v) => s.plus(v), new Prisma.Decimal(0));
      expect(sum.equals(bundle.price)).toBe(true);
    });

    it('splits evenly when all courses are free', () => {
      const free = [
        { id: 'x', price: 0 },
        { id: 'y', price: 0 },
      ];
      const allocations = service.allocateBundlePrice(0, free);
      expect(allocations.get('x')!.isZero()).toBe(true);
      expect(allocations.get('y')!.isZero()).toBe(true);
    });
  });

  describe('enroll', () => {
    const dto = { txHash: 'tx-bundle', amountPaid: 79.99 };

    it('records allocated amounts and revenue that sum to the bundle price', async () => {
      await service.enroll('student-1', 'bundle-1', dto);

      const amounts = tx.enrollment.createMany.mock.calls.map(([args]) => args.data[0].amountPaid);
      const revenue = tx.course.update.mock.calls.map(([args]) => args.data.totalRevenue.increment);

      const sumOf = (vals: Prisma.Decimal[]) => vals.reduce((s, v) => s.plus(v), new Prisma.Decimal(0));
      expect(sumOf(amounts).equals(bundle.price)).toBe(true);
      expect(sumOf(revenue).equals(bundle.price)).toBe(true);
      expect(amounts.some((a) => a.equals(courseA.price))).toBe(false);
    });

    it('verifies the payment tx and records a BUNDLE payment', async () => {
      await service.enroll('student-1', 'bundle-1', dto);

      expect(mockEnrollments.verifyPaymentTransactionBasic).toHaveBeenCalledWith('tx-bundle');
      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ txHash: 'tx-bundle', paymentType: 'BUNDLE' }),
      });
    });

    it('does not enroll when the on-chain payment cannot be verified', async () => {
      mockEnrollments.verifyPaymentTransactionBasic.mockRejectedValue(new BadRequestException('not found'));

      await expect(service.enroll('student-1', 'bundle-1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('runs pre-enrollment checks for every course before writing', async () => {
      mockEnrollments.runPreEnrollmentChecks
        .mockResolvedValueOnce({ action: 'ALLOW' })
        .mockRejectedValueOnce(new ForbiddenException('Prerequisites Not Met'));

      await expect(service.enroll('student-1', 'bundle-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('runs post-enrollment steps (drip schedule, notifications) for each new enrollment', async () => {
      await service.enroll('student-1', 'bundle-1', dto);

      expect(mockEnrollments.runPostEnrollmentSteps).toHaveBeenCalledTimes(3);
      const enrolledCourses = mockEnrollments.runPostEnrollmentSteps.mock.calls.map(([e]) => e.courseId);
      expect(enrolledCourses).toEqual(['course-a', 'course-b', 'course-c']);
    });

    it('skips courses the student already owns', async () => {
      mockPrisma.enrollment.findMany.mockResolvedValue([{ courseId: 'course-b' }]);

      await service.enroll('student-1', 'bundle-1', dto);

      expect(mockEnrollments.runPreEnrollmentChecks).toHaveBeenCalledTimes(2);
      expect(tx.enrollment.createMany).toHaveBeenCalledTimes(2);
      expect(mockEnrollments.runPostEnrollmentSteps).toHaveBeenCalledTimes(2);
    });
  });
});
