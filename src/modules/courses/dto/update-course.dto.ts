import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min, Matches, IsIn } from 'class-validator';
import {
  COURSE_LEVELS,
  CourseLevel,
  LANGUAGE_PATTERN,
  LANGUAGE_PATTERN_MESSAGE,
} from '../course-validation.constants';

export class UpdateCourseDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;

  @ApiPropertyOptional({ example: 'Beginner', enum: COURSE_LEVELS })
  @IsOptional()
  @IsIn(COURSE_LEVELS, { message: `level must be one of: ${COURSE_LEVELS.join(', ')}` })
  level?: CourseLevel;

  @IsOptional()
  @IsString()
  @Matches(LANGUAGE_PATTERN, { message: LANGUAGE_PATTERN_MESSAGE })
  language?: string;
  @IsOptional() @IsString() thumbnailUrl?: string;
  @IsOptional() @IsString() previewVideoUrl?: string;

  @ApiPropertyOptional({ example: 50, description: 'Price in USDC (at most 2 decimal places)' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
}
