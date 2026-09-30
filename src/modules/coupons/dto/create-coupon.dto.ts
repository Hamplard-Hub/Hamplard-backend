import {
  IsString, IsNotEmpty, IsEnum, IsNumber,
  IsOptional, IsInt, IsDate, IsBoolean,
  Min, Max, IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { DiscountType } from '@prisma/client';

export class CreateCouponDto {
  @ApiProperty({ example: 'SAVE20', description: 'Unique coupon code (case-insensitive, stored uppercase)' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ enum: DiscountType, example: DiscountType.PERCENTAGE })
  @IsEnum(DiscountType)
  discountType: DiscountType;

  @ApiProperty({
    example: 20,
    description: 'Percentage value (0-100) for PERCENTAGE type, or fixed USDC amount for FIXED type',
  })
  @IsNumber()
  @IsPositive()
  discountValue: number;

  @ApiProperty({
    required: false,
    example: 100,
    description: 'Maximum number of times this coupon can be redeemed. Null means unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxRedemptions?: number;

  @ApiProperty({
    required: false,
    example: 10,
    description: 'Minimum order amount in USDC required to use this coupon',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ required: false, description: 'Expiry date. Null means never expires.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;

  @ApiProperty({ required: false, description: 'Restrict coupon to a specific course ID' })
  @IsOptional()
  @IsString()
  courseId?: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
