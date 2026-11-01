import {
  Injectable, NotFoundException, ConflictException,
  BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Coupon, DiscountType, EnrollmentStatus, Prisma, UserRole } from '@prisma/client';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ValidateCouponDto } from './dto/validate-coupon.dto';
import { RedeemCouponDto } from './dto/redeem-coupon.dto';

/** The authenticated user acting on a coupon. */
export interface CouponActor {
  id: string;
  role: UserRole | string;
}

@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  async create(actor: CouponActor, dto: CreateCouponDto) {
    const userId = actor.id;
    const code = dto.code.toUpperCase().trim();

    // Validate discountValue is positive
    if (dto.discountValue <= 0) {
      throw new BadRequestException('Discount value must be greater than 0');
    }

    // Validate PERCENTAGE value is within bounds
    if (dto.discountType === DiscountType.PERCENTAGE && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount value cannot exceed 100');
    }

    // Validate minOrderAmount is non-negative
    if (dto.minOrderAmount !== undefined && dto.minOrderAmount !== null && dto.minOrderAmount < 0) {
      throw new BadRequestException('Minimum order amount cannot be negative');
    }

    // Validate maxRedemptions is non-negative
    if (dto.maxRedemptions !== undefined && dto.maxRedemptions !== null && dto.maxRedemptions < 0) {
      throw new BadRequestException('Maximum redemptions cannot be negative');
    }

    // Validate expiresAt is in the future
    if (dto.expiresAt && new Date(dto.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Expiration date must be in the future');
    }

    // Ensure coupon code is unique
    const existing = await this.prisma.coupon.findUnique({ where: { code } });
    if (existing) throw new ConflictException(`Coupon code "${code}" already exists`);

    // Validate courseId (instructors must scope coupons to a course they own)
    await this.assertCanScopeToCourse(actor, dto.courseId);

    const coupon = await this.prisma.coupon.create({
      data: {
        code,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxRedemptions: dto.maxRedemptions ?? null,
        minOrderAmount: dto.minOrderAmount ?? null,
        expiresAt: dto.expiresAt ?? null,
        courseId: dto.courseId ?? null,
        isActive: dto.isActive ?? true,
        createdById: userId,
      },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        course: { select: { id: true, title: true } },
      },
    });

    this.logger.log(`Coupon created: ${code} by user ${userId}`);
    return coupon;
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(actor: CouponActor, page = 1, limit = 20, isActive?: boolean) {
    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;
    // Instructors only see coupons they created
    if (!this.isAdmin(actor)) where.createdById = actor.id;

    const [coupons, total] = await this.prisma.$transaction([
      this.prisma.coupon.findMany({
        where,
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
          course: { select: { id: true, title: true } },
          _count: { select: { redemptions: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.coupon.count({ where }),
    ]);

    return { data: coupons, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, actor?: CouponActor) {
    const coupon = await this.prisma.coupon.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        course: { select: { id: true, title: true } },
        _count: { select: { redemptions: true } },
      },
    });
    if (!coupon) throw new NotFoundException(`Coupon ${id} not found`);
    if (actor) this.assertCanManage(coupon, actor);
    return coupon;
  }

  async findByCode(code: string) {
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!coupon) throw new NotFoundException(`Coupon code "${code}" not found`);
    return coupon;
  }

  // ----------------------------------------------------------
  // UPDATE / DEACTIVATE
  // ----------------------------------------------------------

  async update(id: string, dto: UpdateCouponDto, actor: CouponActor) {
    const existing = await this.findOne(id, actor);

    // Re-scoping the coupon follows the same ownership rules as creation
    if (dto.courseId !== undefined) {
      await this.assertCanScopeToCourse(actor, dto.courseId);
    }

    const discountType = dto.discountType ?? existing.discountType;
    const discountValue = dto.discountValue ?? Number(existing.discountValue);
    const minOrderAmount = dto.minOrderAmount !== undefined
      ? dto.minOrderAmount
      : (existing.minOrderAmount ? Number(existing.minOrderAmount) : null);
    const maxRedemptions = dto.maxRedemptions !== undefined ? dto.maxRedemptions : existing.maxRedemptions;

    if (discountValue <= 0) {
      throw new BadRequestException('Discount value must be greater than 0');
    }

    if (discountType === DiscountType.PERCENTAGE && discountValue > 100) {
      throw new BadRequestException('Percentage discount value cannot exceed 100');
    }

    if (minOrderAmount !== null && minOrderAmount < 0) {
      throw new BadRequestException('Minimum order amount cannot be negative');
    }

    if (maxRedemptions !== null && maxRedemptions < 0) {
      throw new BadRequestException('Maximum redemptions cannot be negative');
    }

    if (dto.expiresAt !== undefined && dto.expiresAt !== null && new Date(dto.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('Expiration date must be in the future');
    }

    return this.prisma.coupon.update({
      where: { id },
      data: { ...dto },
    });
  }

  async deactivate(id: string, actor: CouponActor) {
    await this.findOne(id, actor);
    return this.prisma.coupon.update({ where: { id }, data: { isActive: false } });
  }

  // ----------------------------------------------------------
  // VALIDATE AT CHECKOUT
  // ----------------------------------------------------------

  /**
   * Validates a coupon code for a specific course and user,
   * returning the discounted price if valid.
   * The course price is always looked up server-side; any client-supplied
   * price is ignored. Does NOT record the redemption — call redeem() at purchase time.
   */
  async validate(userId: string, dto: ValidateCouponDto) {
    const code = dto.code.toUpperCase().trim();
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    if (!coupon) throw new NotFoundException(`Coupon code "${dto.code}" not found`);

    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      select: { id: true, price: true },
    });
    if (!course) throw new NotFoundException(`Course ${dto.courseId} not found`);

    const originalPrice = Number(course.price);
    this.assertCouponUsable(coupon, course.id, originalPrice);

    // Check if user already redeemed this coupon for this course
    const alreadyRedeemed = await this.prisma.couponRedemption.findUnique({
      where: { couponId_userId_courseId: { couponId: coupon.id, userId, courseId: course.id } },
    });
    if (alreadyRedeemed) {
      throw new ConflictException('You have already used this coupon for this course');
    }

    const { discountAmount, finalPrice } = this.priceWithDiscount(coupon, originalPrice);

    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      discountAmount,
      originalPrice,
      finalPrice,
      expiresAt: coupon.expiresAt,
      remainingRedemptions:
        coupon.maxRedemptions !== null ? coupon.maxRedemptions - coupon.redeemedCount : null,
    };
  }

  // ----------------------------------------------------------
  // REDEEM (called after successful checkout)
  // ----------------------------------------------------------

  /**
   * Records a coupon redemption against one of the caller's verified enrollments.
   * The course and discount are derived server-side, every validity check is
   * re-run inside the transaction, and the redemption counter is bumped with a
   * conditional update so concurrent redemptions can never exceed maxRedemptions.
   */
  async redeem(userId: string, dto: RedeemCouponDto) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: dto.enrollmentId },
      select: {
        id: true,
        studentId: true,
        courseId: true,
        status: true,
        course: { select: { id: true, price: true } },
      },
    });
    if (
      !enrollment
      || enrollment.studentId !== userId
      || (enrollment.status !== EnrollmentStatus.ACTIVE
        && enrollment.status !== EnrollmentStatus.COMPLETED)
    ) {
      throw new ForbiddenException('A verified enrollment is required to redeem a coupon');
    }

    const courseId = enrollment.courseId;
    const originalPrice = Number(enrollment.course.price);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const coupon = await tx.coupon.findUnique({ where: { id: dto.couponId } });
        if (!coupon) throw new NotFoundException('Coupon not found');

        this.assertCouponUsable(coupon, courseId, originalPrice);

        const now = new Date();
        const { count } = await tx.coupon.updateMany({
          where: {
            id: coupon.id,
            isActive: true,
            AND: [
              { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              coupon.maxRedemptions !== null
                ? { redeemedCount: { lt: coupon.maxRedemptions } }
                : {},
            ],
          },
          data: { redeemedCount: { increment: 1 } },
        });
        if (count !== 1) {
          throw new BadRequestException('This coupon has reached its usage limit');
        }

        const { discountAmount, finalPrice } = this.priceWithDiscount(coupon, originalPrice);

        const redemption = await tx.couponRedemption.create({
          data: { couponId: coupon.id, userId, courseId, discount: discountAmount },
        });

        return {
          ...redemption,
          enrollmentId: enrollment.id,
          originalPrice,
          discountAmount,
          finalPrice,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already used this coupon for this course');
      }
      throw error;
    }
  }

  // ----------------------------------------------------------
  // REDEMPTION HISTORY
  // ----------------------------------------------------------

  async getRedemptions(couponId: string, actor: CouponActor, page = 1, limit = 20) {
    await this.findOne(couponId, actor);

    const [redemptions, total] = await this.prisma.$transaction([
      this.prisma.couponRedemption.findMany({
        where: { couponId },
        include: {
          user: { select: { id: true, name: true, stellarAddress: true } },
        },
        orderBy: { redeemedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.couponRedemption.count({ where: { couponId } }),
    ]);

    return { data: redemptions, meta: { total, page, limit } };
  }

  /**
   * Returns performance stats for a coupon: redemptions, revenue, discount given,
   * aggregated both in total and broken down by day.
   * Restricted to the coupon's creator or admins (Issue #496).
   */
  async getStats(couponId: string, actor: CouponActor) {
    const coupon = await this.findOne(couponId, actor);

    const redemptions = await this.prisma.couponRedemption.findMany({
      where: { couponId },
      orderBy: { redeemedAt: 'asc' },
    });

    // Fetch associated courses to derive original course prices
    const courseIds = [...new Set(redemptions.map((r) => r.courseId))];
    const courses =
      courseIds.length > 0
        ? await this.prisma.course.findMany({
            where: { id: { in: courseIds } },
            select: { id: true, price: true },
          })
        : [];

    const priceMap = new Map(courses.map((c) => [c.id, Number(c.price)]));

    let totalDiscountGiven = 0;
    let totalRevenue = 0;
    const dailyMap = new Map<
      string,
      { date: string; redemptions: number; revenue: number; discountGiven: number }
    >();

    for (const r of redemptions) {
      const discount = Number(r.discount);
      const originalPrice = priceMap.get(r.courseId) ?? discount;
      const revenue = Math.max(0, originalPrice - discount);

      totalDiscountGiven += discount;
      totalRevenue += revenue;

      const dateStr = r.redeemedAt.toISOString().split('T')[0];
      const entry = dailyMap.get(dateStr) ?? {
        date: dateStr,
        redemptions: 0,
        revenue: 0,
        discountGiven: 0,
      };

      entry.redemptions += 1;
      entry.revenue = Number((entry.revenue + revenue).toFixed(2));
      entry.discountGiven = Number((entry.discountGiven + discount).toFixed(2));
      dailyMap.set(dateStr, entry);
    }

    return {
      couponId: coupon.id,
      code: coupon.code,
      totalRedemptions: redemptions.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalDiscountGiven: Number(totalDiscountGiven.toFixed(2)),
      byDay: Array.from(dailyMap.values()),
    };
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private isAdmin(actor: CouponActor) {
    return actor.role === UserRole.ADMIN;
  }

  /** Only the coupon's creator or an admin may view or manage it. */
  private assertCanManage(coupon: { createdById: string }, actor: CouponActor) {
    if (!this.isAdmin(actor) && coupon.createdById !== actor.id) {
      throw new ForbiddenException('You can only manage coupons you created');
    }
  }

  /**
   * Admins may create platform-wide coupons or scope them to any course.
   * Everyone else must scope the coupon to a course they own.
   */
  private async assertCanScopeToCourse(actor: CouponActor, courseId: string | null | undefined) {
    if (!courseId) {
      if (!this.isAdmin(actor)) {
        throw new ForbiddenException('Instructors must scope coupons to a course they own');
      }
      return;
    }

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, instructor: { select: { id: true } } },
    });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    // course.instructorAddress is a Stellar address, so compare by user id
    if (!this.isAdmin(actor) && course.instructor?.id !== actor.id) {
      throw new ForbiddenException('You can only create coupons for courses you own');
    }
  }

  /** Throws if the coupon cannot be applied to the given course at the given server-side price. */
  private assertCouponUsable(coupon: Coupon, courseId: string, originalPrice: number) {
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('This coupon has expired');
    }

    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }

    if (coupon.courseId && coupon.courseId !== courseId) {
      throw new ForbiddenException('This coupon is not valid for the selected course');
    }

    if (coupon.minOrderAmount !== null && originalPrice < Number(coupon.minOrderAmount)) {
      throw new BadRequestException(
        `This coupon requires a minimum order of ${coupon.minOrderAmount} USDC`,
      );
    }
  }

  private priceWithDiscount(coupon: Coupon, originalPrice: number) {
    const discountAmount = this.calculateDiscount(
      coupon.discountType,
      Number(coupon.discountValue),
      originalPrice,
    );
    const finalPrice = Math.max(0, originalPrice - discountAmount);
    return {
      discountAmount: Number(discountAmount.toFixed(2)),
      finalPrice: Number(finalPrice.toFixed(2)),
    };
  }

  private calculateDiscount(
    type: DiscountType,
    value: number,
    originalPrice: number,
  ): number {
    if (type === DiscountType.PERCENTAGE) {
      return (originalPrice * Math.min(value, 100)) / 100;
    }
    // FIXED — cap at original price so finalPrice never goes negative
    return Math.min(value, originalPrice);
  }
}
