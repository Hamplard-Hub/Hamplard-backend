import { IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRewardRulesDto {
  @ApiProperty({ required: false, example: 10, description: 'Percent discount for the referrer on conversion' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  referrerDiscountPercent?: number;

  @ApiProperty({ required: false, example: 10, description: 'Percent welcome discount for the referred user' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  refereeDiscountPercent?: number;

  @ApiProperty({ required: false, example: 90, description: 'Days until an issued reward expires' })
  @IsOptional()
  @IsInt()
  @Min(1)
  rewardExpiryDays?: number;

  @ApiProperty({ required: false, example: 50, description: 'Max referrer rewards a single user may earn' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRewardsPerReferrer?: number;
}
