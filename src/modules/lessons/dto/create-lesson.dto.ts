import { IsString, IsNotEmpty, IsOptional, IsInt, Min, IsBoolean, IsEnum, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LessonType } from '@prisma/client';
import { getUrlValidationOptions } from '../../../common/validators/url-validation';

export class CreateLessonDto {
  @ApiProperty({ description: 'ID of the module this lesson belongs to', example: 'module-uuid-1' })
  @IsString()
  @IsNotEmpty()
  moduleId: string;

  @ApiProperty({ description: 'Lesson title', example: 'Lesson 1: Tools and Materials' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ description: 'Detailed lesson description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Type of lesson (VIDEO, TEXT, QUIZ, ASSIGNMENT)',
    enum: LessonType,
    default: LessonType.VIDEO,
  })
  @IsOptional()
  @IsEnum(LessonType)
  type?: LessonType;

  @ApiPropertyOptional({ description: 'Video playback URL' })
  @IsOptional()
  @IsUrl(getUrlValidationOptions())
  videoUrl?: string;

  @ApiPropertyOptional({ description: 'Video duration in seconds', example: 600 })
  @IsOptional()
  @IsInt()
  @Min(0)
  videoDuration?: number;

  @ApiPropertyOptional({
    description: 'Timed quiz duration in minutes',
    default: 15,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  quizDurationMinutes?: number;

  @ApiPropertyOptional({ description: 'URL of the lesson thumbnail' })
  @IsOptional()
  @IsUrl(getUrlValidationOptions())
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Text content for text lessons' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Supplementary resource URL' })
  @IsOptional()
  @IsUrl(getUrlValidationOptions())
  resourceUrl?: string;

  @ApiProperty({ description: 'Ordering position within the module', example: 1 })
  @IsInt()
  @Min(0)
  position: number;

  @ApiPropertyOptional({ description: 'Whether this lesson can be viewed as a free preview', default: false })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;
}
