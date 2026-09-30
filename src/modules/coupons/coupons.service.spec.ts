import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CouponsService } from './coupons.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DiscountType } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

describe('CouponsService (Issue #145) — Validation of expiresAt and discount bounds', () => {
  let service: CouponsService;

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
      findMany: jest.fn(),
      count: jest.fn(),
    },
    course: {
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

      const result = await service.create('user-1', dto);
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

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
        'Expiration date must be in the future',
      );
    });

    it('should reject non-positive discountValue with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'NEGDISCOUNT',
        discountType: DiscountType.FIXED,
        discountValue: -10,
      };

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject zero discountValue with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'ZERODISCOUNT',
        discountType: DiscountType.FIXED,
        discountValue: 0,
      };

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject percentage discountValue exceeding 100 with BadRequestException (400)', async () => {
      const dto: CreateCouponDto = {
        code: 'OVER100',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 150,
      };

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
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

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
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

      await expect(service.create('user-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('user-1', dto)).rejects.toThrow(
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

      const result = await service.update('coupon-1', dto);
      expect(result.discountValue).toBe(25);
    });

    it('should reject updating expiresAt to a past date', async () => {
      const pastDate = new Date(Date.now() - 3600000);
      const dto: UpdateCouponDto = { expiresAt: pastDate };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto)).rejects.toThrow(
        'Expiration date must be in the future',
      );
    });

    it('should reject updating discountValue to negative or zero', async () => {
      const dto: UpdateCouponDto = { discountValue: -5 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto)).rejects.toThrow(
        'Discount value must be greater than 0',
      );
    });

    it('should reject updating percentage discountValue to greater than 100', async () => {
      const dto: UpdateCouponDto = { discountValue: 110 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });

    it('should reject updating minOrderAmount to negative value', async () => {
      const dto: UpdateCouponDto = { minOrderAmount: -20 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto)).rejects.toThrow(
        'Minimum order amount cannot be negative',
      );
    });

    it('should reject updating maxRedemptions to negative value', async () => {
      const dto: UpdateCouponDto = { maxRedemptions: -10 };

      mockPrisma.coupon.findUnique.mockResolvedValue(mockExistingCoupon);

      await expect(service.update('coupon-1', dto)).rejects.toThrow(BadRequestException);
      await expect(service.update('coupon-1', dto)).rejects.toThrow(
        'Maximum redemptions cannot be negative',
      );
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
});
