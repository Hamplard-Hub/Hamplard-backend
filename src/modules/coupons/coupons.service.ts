import {
  Injectable, NotFoundException, ConflictException,
  BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DiscountType } from '@prisma/client';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  async create(userId: string, dto: CreateCouponDto) {
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

    // Validate courseId if provided
    if (dto.courseId) {
      const course = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
      if (!course) throw new NotFoundException(`Course ${dto.courseId} not found`);
    }

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

  async findAll(page = 1, limit = 20, isActive?: boolean) {
    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;

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

  async findOne(id: string) {
    const coupon = await this.prisma.coupon.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        course: { select: { id: true, title: true } },
        _count: { select: { redemptions: true } },
      },
    });
    if (!coupon) throw new NotFoundException(`Coupon ${id} not found`);
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

  async update(id: string, dto: UpdateCouponDto) {
    const existing = await this.findOne(id);

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

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.coupon.update({ where: { id }, data: { isActive: false } });
  }

  // ----------------------------------------------------------
  // VALIDATE AT CHECKOUT
  // ----------------------------------------------------------

  /**
   * Validates a coupon code for a specific course and user,
   * returning the discounted price if valid.
   * Does NOT record the redemption — call redeemCoupon() at purchase time.
   */
  async validate(userId: string, dto: ValidateCouponDto) {
    const code = dto.code.toUpperCase().trim();
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });

    if (!coupon) throw new NotFoundException(`Coupon code "${dto.code}" not found`);
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');

    // Check expiry
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('This coupon has expired');
    }

    // Check usage limits
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }

    // Check course restriction
    if (coupon.courseId && coupon.courseId !== dto.courseId) {
      throw new ForbiddenException('This coupon is not valid for the selected course');
    }

    // Check minimum order amount
    if (coupon.minOrderAmount !== null && dto.originalPrice < Number(coupon.minOrderAmount)) {
      throw new BadRequestException(
        `This coupon requires a minimum order of ${coupon.minOrderAmount} USDC`,
      );
    }

    // Check if user already redeemed this coupon for this course
    const alreadyRedeemed = await this.prisma.couponRedemption.findUnique({
      where: { couponId_userId_courseId: { couponId: coupon.id, userId, courseId: dto.courseId } },
    });
    if (alreadyRedeemed) {
      throw new ConflictException('You have already used this coupon for this course');
    }

    // Calculate discount
    const discountAmount = this.calculateDiscount(
      coupon.discountType,
      Number(coupon.discountValue),
      dto.originalPrice,
    );
    const finalPrice = Math.max(0, dto.originalPrice - discountAmount);

    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: Number(coupon.discountValue),
      discountAmount: Number(discountAmount.toFixed(2)),
      originalPrice: dto.originalPrice,
      finalPrice: Number(finalPrice.toFixed(2)),
      expiresAt: coupon.expiresAt,
      remainingRedemptions:
        coupon.maxRedemptions !== null ? coupon.maxRedemptions - coupon.redeemedCount : null,
    };
  }

  // ----------------------------------------------------------
  // REDEEM (called after successful checkout)
  // ----------------------------------------------------------

  async redeem(userId: string, couponId: string, courseId: string, discountAmount: number) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id: couponId } });
    if (!coupon) throw new NotFoundException('Coupon not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.couponRedemption.create({
        data: { couponId, userId, courseId, discount: discountAmount },
      });
      await tx.coupon.update({
        where: { id: couponId },
        data: { redeemedCount: { increment: 1 } },
      });
    });
  }

  // ----------------------------------------------------------
  // REDEMPTION HISTORY
  // ----------------------------------------------------------

  async getRedemptions(couponId: string, page = 1, limit = 20) {
    await this.findOne(couponId);

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

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

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
