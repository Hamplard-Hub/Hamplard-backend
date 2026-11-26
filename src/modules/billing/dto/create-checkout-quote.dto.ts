import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCheckoutQuoteDto {
  @ApiProperty({ description: 'Course being purchased' })
  @IsString() @IsNotEmpty()
  courseId: string;

  @ApiPropertyOptional({ example: 'NG', description: 'Region code for tax lookup, e.g. NG, US, GB, EU' })
  @IsOptional() @IsString() @MaxLength(16)
  region?: string;

  @ApiPropertyOptional({ example: 'SAVE20', description: 'Coupon code to apply' })
  @IsOptional() @IsString() @IsNotEmpty()
  couponCode?: string;

  @ApiPropertyOptional({ description: 'ID of one of the caller\'s issued referral rewards to apply' })
  @IsOptional() @IsString() @IsNotEmpty()
  referralRewardId?: string;
}
