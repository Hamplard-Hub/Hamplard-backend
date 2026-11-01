import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CouponsService } from './coupons.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DiscountType, EnrollmentStatus, UserRole } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

describe('CouponsService (Issue #145) — Validation of expiresAt and discount bounds', () => {
  let service: CouponsService;

  const admin = { id: 'admin-1', role: UserRole.ADMIN };

  const mockExistingCoupon = {
    id: 'coupon-1',
    code: 'SAVE20',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 20,
    maxRedemptions: 100,
    minOrderAmount: 10,
    expiresAt: new Date(Date.now() + 86400000), // tomorrow
    courseId: null,
    isActive: true,
    createdById: 'user-1',
    redeemedCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrisma = {
    coupon: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    course: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    couponRedemption: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    enrollment: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CouponsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CouponsService>(CouponsService);
    jest.clearAllMocks();
  });

  describe('CouponsService.create', () => {
    it('should create a valid coupon successfully', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const dto: CreateCouponDto = {
        code: 'SAVE20',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 20,
        minOrderAmount: 50,
        maxRedemptions: 10,
        expiresAt: futureDate,
      };

      mockPrisma.coupon.findUnique.mockResolvedValue(null);
      mockPrisma.coupon.create.mockResolvedValue({ ...mockExistingCoupon, ...dto });

      const result = await service.create(admin, dto);
      expect(result).toBeDefined();
      expect(mockPrisma.coupon.create).toHaveBeenCalled();
    });

    it('should reject past expiresAt with BadRequestException (400)', async () => {
      const pastDate = new Date(Date.now() - 3600000);
      const dto: CreateCouponDto = {
        code: 'PASTEXPIRE',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 15,
        expiresAt: pastDate,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Expiration date must be in the future',
      );
    });

    it('should reject non-positive discountValue with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'NEGDISCOUNT',
        discountType: DiscountType.FIXED,
        discountValue: -10,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject zero discountValue with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'ZERODISCOUNT',
        discountType: DiscountType.FIXED,
        discountValue: 0,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject percentage discountValue exceeding 100 with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'OVER100',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 150,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });

    it('should reject negative minOrderAmount with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'NEGMINORDER',
        discountType: DiscountType.FIXED,
        discountValue: 10,
        minOrderAmount: -5,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Minimum order amount cannot be negative',
      );
    });

    it('should reject negative maxRedemptions with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'NEGMAXRED',
        discountType: DiscountType.FIXED,
        discountValue: 10,
        maxRedemptions: -1,
      };

      await expect(service.create(admin, dto)).rejects.toThrow(BadRequestException);
      await expect(service.create(admin, dto)).rejects.toThrow(
        'Maximum redemptions cannot be negative',
      );
    });
  });

  describe('CouponsService.update', () => {
    it('should update a coupon successfully with valid inputs', async () => {
      const futureDate = new Date(Date.now() + 172800000);
      const dto: UpdateCouponDto = {
        discountValue: 25,
        expiresAt: futureDate,
      };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);
      mockPrisma.coupon.update.mockResolvedValue({
        ...mockExistingCoupon,
        discountValue: 25,
        expiresAt: futureDate,
      });

      const result = await service.update('coupon-1', dto, admin);
      expect(result.discountValue).toBe(25);
    });

    it('should reject updating expiresAt to a past date', async () => {
      const pastDate = new Date(Date.now() - 3600000);
      const dto: UpdateCouponDto = { expiresAt: pastDate };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(
        'Expiration date must be in the future',
      );
    });

    it('should reject updating discountValue to negative or zero', async () => {
      const dto: UpdateCouponDto = { discountValue: -5 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject updating percentage discountValue to greater than 100', async () => {
      const dto: UpdateCouponDto = { discountValue: 110 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });

    it('should reject updating minOrderAmount to negative value', async () => {
      const dto: UpdateCouponDto = { minOrderAmount: -20 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(
        'Minimum order amount cannot be negative',
      );
    });

    it('should reject updating maxRedemptions to negative value', async () => {
      const dto: UpdateCouponDto = { maxRedemptions: -10 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto, admin)).rejects.toThrow(
        'Maximum redemptions cannot be negative',
      );
    });
  });

  describe('Ownership rules (Issue #277)', () => {
    const instructor = { id: 'inst-1', role: UserRole.INSTRUCTOR };
    const otherInstructor = { id: 'inst-2', role: UserRole.INSTRUCTOR };
    const baseDto: CreateCouponDto = {
      code: 'MYCOURSE10',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
    };

    beforeEach(() => {
      mockPrisma.coupon.findUnique.mockResolvedValue(null);
      mockPrisma.coupon.create.mockImplementation(async ({ data }: any) => data);
    });

    it('rejects platform-wide coupons from instructors', async () => {
      await expect(service.create(instructor, baseDto)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.coupon.create).not.toHaveBeenCalled();
    });

    it('allows admins to create platform-wide coupons', async () => {
      const result: any = await service.create(admin, baseDto);
      expect(result.courseId).toBeNull();
    });

    it('rejects instructor coupons for courses they do not own', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-x', instructor: { id: 'inst-2' } });

      await expect(
        service.create(instructor, { ...baseDto, courseId: 'course-x' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.coupon.create).not.toHaveBeenCalled();
    });

    it('allows instructor coupons for their own course', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });

      const result: any = await service.create(instructor, { ...baseDto, courseId: 'course-1' });
      expect(result.courseId).toBe('course-1');
      expect(result.createdById).toBe('inst-1');
    });

    it('filters the coupon list to the instructor\'s own coupons', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.findAll(instructor);
      expect(mockPrisma.coupon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { createdById: 'inst-1' } }),
      );

      await service.findAll(admin);
      expect(mockPrisma.coupon.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('returns 403 when an instructor views, updates, deactivates or lists redemptions of another user\'s coupon', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue({ ...mockExistingCoupon, createdById: 'inst-2' });

      await expect(service.findOne('coupon-1', instructor)).rejects.toThrow(ForbiddenException);
      await expect(
        service.update('coupon-1', { discountValue: 50 }, instructor),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.deactivate('coupon-1', instructor)).rejects.toThrow(ForbiddenException);
      await expect(service.getRedemptions('coupon-1', instructor)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.coupon.update).not.toHaveBeenCalled();
    });

    it('lets the creator and admins manage a coupon', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue({ ...mockExistingCoupon, createdById: 'inst-2' });
      mockPrisma.coupon.update.mockResolvedValue({});

      await expect(service.deactivate('coupon-1', otherInstructor)).resolves.toBeDefined();
      await expect(service.deactivate('coupon-1', admin)).resolves.toBeDefined();
    });

    it('prevents instructors from re-scoping their coupon to another course or platform-wide', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue({ ...mockExistingCoupon, createdById: 'inst-1' });
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-x', instructor: { id: 'inst-2' } });

      await expect(
        service.update('coupon-1', { courseId: 'course-x' }, instructor),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.update('coupon-1', { courseId: null }, instructor),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.coupon.update).not.toHaveBeenCalled();
    });
  });

  describe('Server-side pricing and redemption (Issue #278)', () => {
    const activeCoupon = {
      ...mockExistingCoupon,
      id: 'coupon-1',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 20,
      minOrderAmount: 30,
      maxRedemptions: 1,
      redeemedCount: 0,
    };

    describe('validate', () => {
      it('uses the course price from the database and ignores the client price', async () => {
        mockPrisma.coupon.findUnique.mockResolvedValue(activeCoupon);
        mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', price: 100 });
        mockPrisma.couponRedemption.findUnique.mockResolvedValue(null);

        const dto: ValidateCouponDto = { code: 'save20', courseId: 'course-1', originalPrice: 1000 };
        const result = await service.validate('student-1', dto);

        expect(result.originalPrice).toBe(100);
        expect(result.discountAmount).toBe(20);
        expect(result.finalPrice).toBe(80);
      });

      it('enforces minOrderAmount against the real course price', async () => {
        mockPrisma.coupon.findUnique.mockResolvedValue(activeCoupon);
        mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', price: 10 });

        await expect(
          service.validate('student-1', { code: 'SAVE20', courseId: 'course-1', originalPrice: 500 }),
        ).rejects.toThrow('minimum order');
      });

      it('returns 404 when the course does not exist', async () => {
        mockPrisma.coupon.findUnique.mockResolvedValue(activeCoupon);
        mockPrisma.course.findUnique.mockResolvedValue(null);

        await expect(
          service.validate('student-1', { code: 'SAVE20', courseId: 'missing' }),
        ).rejects.toThrow(NotFoundException);
      });
    });

    describe('redeem', () => {
      const enrollment = {
        id: 'enr-1',
        studentId: 'student-1',
        courseId: 'course-1',
        status: EnrollmentStatus.ACTIVE,
        course: { id: 'course-1', price: 100 },
      };

      /**
       * In-memory transaction client: the conditional updateMany is evaluated
       * synchronously against shared state, mirroring an atomic DB update.
       */
      const buildTx = (coupon: any) => {
        const state = { ...coupon, redemptions: [] as any[] };
        const tx = {
          coupon: {
            findUnique: jest.fn(async () => ({ ...state })),
            updateMany: jest.fn(async ({ where }: any) => {
              const limit = where.AND[1]?.redeemedCount?.lt;
              if (!state.isActive) return { count: 0 };
              if (limit !== undefined && state.redeemedCount >= limit) return { count: 0 };
              state.redeemedCount += 1;
              return { count: 1 };
            }),
          },
          couponRedemption: {
            create: jest.fn(async ({ data }: any) => {
              state.redemptions.push(data);
              return { id: `red-${state.redemptions.length}`, ...data };
            }),
          },
        };
        mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
        return { state, tx };
      };

      it('requires an enrollment owned by the caller', async () => {
        mockPrisma.enrollment.findUnique.mockResolvedValue({ ...enrollment, studentId: 'someone-else' });

        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow(ForbiddenException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('rejects refunded or missing enrollments', async () => {
        mockPrisma.enrollment.findUnique.mockResolvedValue({ ...enrollment, status: EnrollmentStatus.REFUNDED });
        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow(ForbiddenException);

        mockPrisma.enrollment.findUnique.mockResolvedValue(null);
        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('recomputes the discount server-side from the course price', async () => {
        mockPrisma.enrollment.findUnique.mockResolvedValue(enrollment);
        const { state } = buildTx(activeCoupon);

        const result = await service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' });

        expect(result.discountAmount).toBe(20);
        expect(state.redemptions[0]).toEqual(
          expect.objectContaining({ courseId: 'course-1', userId: 'student-1', discount: 20 }),
        );
      });

      it('re-checks active and expiry status at redemption time', async () => {
        mockPrisma.enrollment.findUnique.mockResolvedValue(enrollment);

        buildTx({ ...activeCoupon, isActive: false });
        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow('no longer active');

        buildTx({ ...activeCoupon, expiresAt: new Date(Date.now() - 1000) });
        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow('expired');
      });

      it('rejects coupons scoped to a different course than the enrollment', async () => {
        mockPrisma.enrollment.findUnique.mockResolvedValue(enrollment);
        buildTx({ ...activeCoupon, courseId: 'course-other' });

        await expect(
          service.redeem('student-1', { couponId: 'coupon-1', enrollmentId: 'enr-1' }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('never exceeds maxRedemptions under concurrent redemptions', async () => {
        mockPrisma.enrollment.findUnique.mockImplementation(async ({ where }: any) => ({
          ...enrollment,
          id: where.id,
          studentId: `student-${where.id}`,
        }));
        const { state } = buildTx({ ...activeCoupon, maxRedemptions: 2 });

        // Every transaction reads the coupon before any counter update lands
        const results = await Promise.allSettled(
          ['a', 'b', 'c', 'd', 'e'].map((id) =>
            service.redeem(`student-${id}`, { couponId: 'coupon-1', enrollmentId: id }),
          ),
        );

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        expect(state.redeemedCount).toBe(2);
        expect(state.redemptions).toHaveLength(2);
      });
    });
  });

  describe('DTO Class-Validator Rules', () => {
    it('CreateCouponDto fails validation if discountValue is <= 0', async () => {
      const plain = {
        code: 'TESTDTO',
        discountType: DiscountType.FIXED,
        discountValue: -5,
      };
      const dto = plainToInstance(CreateCouponDto, plain);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'discountValue')).toBe(true);
    });

    it('CreateCouponDto fails validation if minOrderAmount is negative', async () => {
      const plain = {
        code: 'TESTDTO',
        discountType: DiscountType.FIXED,
        discountValue: 10,
        minOrderAmount: -1,
      };
      const dto = plainToInstance(CreateCouponDto, plain);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'minOrderAmount')).toBe(true);
    });

    it('CreateCouponDto fails validation if maxRedemptions is negative', async () => {
      const plain = {
        code: 'TESTDTO',
        discountType: DiscountType.FIXED,
        discountValue: 10,
        maxRedemptions: -1,
      };
      const dto = plainToInstance(CreateCouponDto, plain);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'maxRedemptions')).toBe(true);
    });

    it('UpdateCouponDto fails validation if minOrderAmount or discountValue is negative', async () => {
      const plain = {
        discountValue: -10,
      };
      const dto = plainToInstance(UpdateCouponDto, plain);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'discountValue')).toBe(true);
    });
  });

  describe('Coupon performance stats (Issue #496)', () => {
    const owner = { id: 'user-1', role: UserRole.INSTRUCTOR };
    const otherInstructor = { id: 'user-2', role: UserRole.INSTRUCTOR };

    it('returns total redemptions, revenue, discount given and daily breakdown for owner', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      const redemptions = [
        {
          id: 'red-1',
          couponId: 'coupon-1',
          courseId: 'course-1',
          discount: 20,
          redeemedAt: new Date('2026-10-25T10:00:00Z'),
        },
        {
          id: 'red-2',
          couponId: 'coupon-1',
          courseId: 'course-1',
          discount: 20,
          redeemedAt: new Date('2026-10-25T14:30:00Z'),
        },
        {
          id: 'red-3',
          couponId: 'coupon-1',
          courseId: 'course-2',
          discount: 10,
          redeemedAt: new Date('2026-10-26T09:15:00Z'),
        },
      ];

      mockPrisma.couponRedemption.findMany.mockResolvedValue(redemptions);
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', price: 100 },
        { id: 'course-2', price: 50 },
      ]);

      const result = await service.getStats('coupon-1', owner);

      expect(result).toBeDefined();
      expect(result.couponId).toBe('coupon-1');
      expect(result.code).toBe('SAVE20');
      expect(result.totalRedemptions).toBe(3);
      // Course-1 price 100, discount 20 -> revenue 80 each (x2 = 160)
      // Course-2 price 50, discount 10 -> revenue 40 (x1 = 40)
      // Total revenue = 200, Total discount = 50
      expect(result.totalRevenue).toBe(200);
      expect(result.totalDiscountGiven).toBe(50);

      expect(result.byDay).toHaveLength(2);
      expect(result.byDay[0]).toEqual({
        date: '2026-10-25',
        redemptions: 2,
        revenue: 160,
        discountGiven: 40,
      });
      expect(result.byDay[1]).toEqual({
        date: '2026-10-26',
        redemptions: 1,
        revenue: 40,
        discountGiven: 10,
      });
    });

    it('allows admins to view performance stats of any coupon', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);
      mockPrisma.couponRedemption.findMany.mockResolvedValue([]);
      mockPrisma.course.findMany.mockResolvedValue([]);

      const result = await service.getStats('coupon-1', admin);
      expect(result.totalRedemptions).toBe(0);
      expect(result.totalRevenue).toBe(0);
      expect(result.totalDiscountGiven).toBe(0);
      expect(result.byDay).toEqual([]);
    });

    it('rejects an instructor viewing stats for another user coupon with 403 Forbidden', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.getStats('coupon-1', otherInstructor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.getStats('coupon-1', otherInstructor)).rejects.toThrow(
        'You can only manage coupons you created',
      );
    });

    it('returns empty stats correctly when a coupon has zero redemptions', async () => {
      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);
      mockPrisma.couponRedemption.findMany.mockResolvedValue([]);
      mockPrisma.course.findMany.mockResolvedValue([]);

      const result = await service.getStats('coupon-1', owner);
      expect(result.totalRedemptions).toBe(0);
      expect(result.totalRevenue).toBe(0);
      expect(result.totalDiscountGiven).toBe(0);
      expect(result.byDay).toEqual([]);
    });
  });
});
