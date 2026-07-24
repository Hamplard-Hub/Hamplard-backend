import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsBoolean } from 'class-validator';
import { CommentReviewStatus } from '@prisma/client';

export class ReviewCommentDto {
  @ApiProperty({ enum: CommentReviewStatus })
  @IsEnum(CommentReviewStatus)
  reviewStatus: CommentReviewStatus;

  @ApiPropertyOptional({ description: 'Optional moderator notes for the review action' })
  @IsOptional()
  @IsString()
  moderationNotes?: string;

  @ApiPropertyOptional({ description: 'Whether the comment should remain hidden after review' })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;
}
