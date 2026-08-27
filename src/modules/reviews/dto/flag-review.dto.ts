import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FlagReason } from '@prisma/client';

export class FlagReviewDto {
  @ApiProperty({ enum: FlagReason, example: FlagReason.SPAM })
  @IsEnum(FlagReason)
  reason: FlagReason;

  @ApiProperty({ required: false, example: 'Looks like a promotional post from the instructor.' })
  @IsOptional() @IsString()
  details?: string;
}
