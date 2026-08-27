import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ModerationAction } from '@prisma/client';

export class ModerateReviewDto {
  @ApiProperty({
    enum: ModerationAction,
    example: ModerationAction.REMOVED,
    description: 'APPROVED = clear the review and make it visible again; REMOVED = take the review down',
  })
  @IsEnum(ModerationAction)
  action: ModerationAction;

  @ApiProperty({ required: false, example: 'Contains offensive language targeting the instructor.' })
  @IsOptional() @IsString()
  reason?: string;
}
