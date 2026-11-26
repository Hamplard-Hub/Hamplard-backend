// bundles.service.ts
import {
  Injectable, NotFoundException, BadRequestException,
  ConflictException, ForbiddenException, Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateBundleDto } from './dto/create-bundle.dto';
import { EnrollBundleDto } from './dto/enroll-bundle.dto';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { FraudCheckResult } from '../enrollments/fraud-detection.service';
import { buildPricingSnapshot } from '../enrollments/pricing-snapshot';

@Injectable()
export class BundlesService {
  private readonly logger = new Logger(BundlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  async create(instructorId: string, instructorAddress: string, dto: CreateBundleDto) {
    const courses = await this.prisma.course.findMany({
      where: { id: { in: dto.courseIds } },
    });

    if (courses.length !== dto.courseIds.length) {
      throw new NotFoundException('One or more courses in the bundle were not found');
    }
    const foreignCourse = courses.find((c) => c.instructorAddress !== instructorAddress);
    if (foreignCourse) {
      throw new ForbiddenException('You can only bundle courses you own');
    }

    const individualTotal = courses.reduce((sum, c) => sum + Number(c.price), 0);
    if (dto.price >= individualTotal) {
      throw new BadRequestException(
        `Bundle price (${dto.price}) must be less than the sum of individual course prices (${individualTotal})`,
      );
    }

    const bundle = await this.prisma.bundle.create({
      data: {
        instructorAddress,
        title: dto.title,
        description: dto.description,
        price: dto.price,
        thumbnailUrl: dto.thumbnailUrl,
        courses: {
          create: dto.courseIds.map((courseId) => ({ courseId })),
        },
      },
      include: { courses: { include: { course: true } } },
    });

    this.logger.log(`Bundle created: ${bundle.id} by ${instructorAddress}`);
    return bundle;
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(filters: { instructorAddress?: string; page?: number; limit?: number }) {
    const { instructorAddress, page = 1, limit = 20 } = filters;
    const where: any = { isActive: true };
    if (instructorAddress) where.instructorAddress = instructorAddress;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.bundle.findMany({
        where,
        include: {
          courses: { include: { course: { select: { id: true, title: true, price: true, thumbnailUrl: true } } } },
          _count: { select: { enrollments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.bundle.count({ where }),
    ]);
    return { data, meta: { total, page, limit } };
  }

  async findOne(id: string) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id },
      include: {
        courses: { include: { course: true } },
        instructor: { select: { name: true, avatarUrl: true, stellarAddress: true } },
        _count: { select: { enrollments: true } },
      },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');
    return bundle;
  }

  // ----------------------------------------------------------
  // ENROLL — single transaction across bundle + each included course
  //
  // Concurrent requests for the same student/bundle are resolved by the
  // (bundleId, studentId) unique constraint rather than the pre-check alone:
  // the loser's insert fails with P2002, rolling back its transaction, and is
  // surfaced as a 409. Per-course enrollments use ON CONFLICT DO NOTHING so a
  // parallel single-course purchase can't abort the bundle transaction, and
  // course stats are only incremented for rows this request actually created.
  //
  // Issue #279: the bundle price is allocated pro-rata across the included
  // courses (so per-course amountPaid / totalRevenue add up to the bundle
  // price), the payment tx is verified on-chain, and each new course
  // enrollment goes through the same pre/post steps as a single purchase.
  // ----------------------------------------------------------

  async enroll(studentId: string, bundleId: string, dto: EnrollBundleDto) {
    const bundle = await this.findOne(bundleId);
    if (!bundle.isActive) throw new BadRequestException('This bundle is no longer available');

    const existing = await this.prisma.bundleEnrollment.findUnique({
      where: { bundleId_studentId: { bundleId, studentId } },
    });
    if (existing) throw new ConflictException('Already enrolled in this bundle');

    if (dto.amountPaid < Number(bundle.price)) {
      throw new BadRequestException(
        `Amount paid (${dto.amountPaid}) is less than the bundle price (${bundle.price})`,
      );
    }

    // Verify payment transaction (basic check for bundles - issue #403)
    await this.enrollments.verifyPaymentTransactionBasic(dto.txHash);

    const courses = bundle.courses.map(({ course }) => course);
    const allocations = this.allocateBundlePrice(bundle.price, courses);

    // Courses the student already owns are skipped, so they don't need checks
    const alreadyEnrolled = await this.prisma.enrollment.findMany({
      where: { studentId, courseId: { in: courses.map((c) => c.id) } },
      select: { courseId: true },
    });
    const alreadyEnrolledIds = new Set(alreadyEnrolled.map((e) => e.courseId));

    // Validate every course before writing anything
    const fraudResults = new Map<string, FraudCheckResult>();
    for (const course of courses) {
      if (alreadyEnrolledIds.has(course.id)) continue;
      this.enrollments.assertCourseActive(course);
      fraudResults.set(
        course.id,
        await this.enrollments.runPreEnrollmentChecks(
          studentId,
          course.id,
          allocations.get(course.id)!.toNumber(),
        ),
      );
    }

    let result: { bundleEnrollment: any; created: any[] };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.payment.create({
          data: {
            txHash: dto.txHash,
            studentId,
            amountPaid: new Prisma.Decimal(dto.amountPaid),
            paymentType: 'BUNDLE',
          },
        });

        const bundleEnrollment = await tx.bundleEnrollment.create({
          data: { bundleId, studentId, amountPaid: dto.amountPaid, txHash: dto.txHash },
        });

        const created: any[] = [];
        for (const course of courses) {
          if (!fraudResults.has(course.id)) continue;
          const allocated = allocations.get(course.id)!;

          const { count } = await tx.enrollment.createMany({
            data: [{
              studentId,
              courseId: course.id,
              amountPaid: allocated,
              txHash: dto.txHash,
              ...buildPricingSnapshot(course, allocated, 'BUNDLE'),
            }],
            skipDuplicates: true,
          });
          if (count === 0) continue; // already enrolled in this course

          await tx.course.update({
            where: { id: course.id },
            data: {
              totalEnrollments: { increment: 1 },
              totalRevenue: { increment: allocated },
            },
          });

          created.push(
            await tx.enrollment.findUnique({
              where: { studentId_courseId: { studentId, courseId: course.id } },
              include: { course: true },
            }),
          );
        }

        return { bundleEnrollment, created };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        if (String(error.meta?.target ?? '').includes('txHash')) {
          throw new ConflictException(
            `Payment ${dto.txHash} has already been used. One transaction maps to one purchase.`,
          );
        }
        this.logger.warn(`Concurrent bundle enrollment rejected: ${studentId} → ${bundleId}`);
        throw new ConflictException('Already enrolled in this bundle');
      }
      throw error;
    }

    // Notifications, invoices, referral conversion, drip schedules, fraud flags
    for (const enrollment of result.created) {
      await this.enrollments.runPostEnrollmentSteps(
        enrollment,
        fraudResults.get(enrollment.courseId)!,
        dto.txHash,
        Number(enrollment.amountPaid),
      );
    }

    this.logger.log(`Bundle enrollment: ${studentId} → ${bundleId}`);
    return result.bundleEnrollment;
  }

  /**
   * Splits the bundle price across its courses in proportion to each course's
   * list price. Amounts are rounded to cents and the last course absorbs the
   * rounding remainder so the allocations always sum to the bundle price.
   */
  allocateBundlePrice(
    bundlePrice: Prisma.Decimal | number,
    courses: { id: string; price: Prisma.Decimal | number }[],
  ): Map<string, Prisma.Decimal> {
    const total = new Prisma.Decimal(bundlePrice);
    const listTotal = courses.reduce(
      (sum, c) => sum.plus(new Prisma.Decimal(c.price)),
      new Prisma.Decimal(0),
    );

    const allocations = new Map<string, Prisma.Decimal>();
    let allocated = new Prisma.Decimal(0);

    courses.forEach((course, index) => {
      let share: Prisma.Decimal;
      if (index === courses.length - 1) {
        share = total.minus(allocated);
      } else if (listTotal.isZero()) {
        share = total.dividedBy(courses.length).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      } else {
        share = total
          .times(new Prisma.Decimal(course.price))
          .dividedBy(listTotal)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      }
      allocated = allocated.plus(share);
      allocations.set(course.id, share);
    });

    return allocations;
  }
}
