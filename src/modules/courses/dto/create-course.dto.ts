// dto/create-course.dto.ts
import {
  IsString, IsNotEmpty, IsOptional, IsNumber,
  Min, Matches, IsIn,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  COURSE_ID_PATTERN,
  COURSE_ID_PATTERN_MESSAGE,
  COURSE_LEVELS,
  CourseLevel,
  LANGUAGE_PATTERN,
  LANGUAGE_PATTERN_MESSAGE,
} from '../course-validation.constants';

export class CreateCourseDto {
  @ApiProperty({
    example: 'COURSE-TAILORING-001',
    description: '3-64 letters, digits or hyphens. Used in URLs and as the on-chain course_id.',
    minLength: 3,
    maxLength: 64,
  })
  @IsString()
  @Matches(COURSE_ID_PATTERN, { message: COURSE_ID_PATTERN_MESSAGE })
  courseId: string;

  @ApiProperty({ example: 'Professional Tailoring from Scratch' })
  @IsString() @IsNotEmpty()
  title: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  description?: string;

  @ApiProperty({ example: 'Tailoring', description: 'e.g. Tailoring, Makeup, Baking, Photography' })
  @IsString() @IsNotEmpty()
  category: string;

  @ApiProperty({ required: false, example: 'Beginner', enum: COURSE_LEVELS })
  @IsOptional()
  @IsIn(COURSE_LEVELS, { message: `level must be one of: ${COURSE_LEVELS.join(', ')}` })
  level?: CourseLevel;

  @ApiProperty({ required: false, example: 'English' })
  @IsOptional()
  @IsString()
  @Matches(LANGUAGE_PATTERN, { message: LANGUAGE_PATTERN_MESSAGE })
  language?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  thumbnailUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  previewVideoUrl?: string;

  @ApiProperty({ example: 50, description: 'Price in USDC (at most 2 decimal places)' })
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  price: number;
}
