import { IsString, IsNotEmpty, IsNumber, IsPositive, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ApplyReferralRewardDto {
  @ApiProperty({ example: 'course-uuid', description: 'Course the discount is being applied to' })
  @IsString()
  @IsNotEmpty()
  courseId: string;

  @ApiProperty({ example: 50, description: 'Original course price in USDC' })
  @IsNumber()
  @IsPositive()
  originalPrice: number;

  @ApiProperty({
    required: false,
    description: 'Specific reward ID to apply. If omitted, the best available reward is used.',
  })
  @IsOptional()
  @IsString()
  rewardId?: string;
}
