import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsUrl,
} from 'class-validator';

export class CreatePathDto {
  /**
   * Display title of the learning path — e.g. "Fashion Design Track".
   */
  @ApiProperty({
    description: 'Human-readable learning path title',
    example: 'Fashion Design Track',
    minLength: 3,
    maxLength: 120,
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  /**
   * Short markdown-friendly description of what the path teaches.
   */
  @ApiPropertyOptional({
    description: 'What a student will achieve by completing the path',
    example: 'From pattern drafting to launching your own tailoring brand.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * Optional cover image URL.
   */
  @ApiPropertyOptional({
    description: 'Cover image shown on the path card',
    example: 'https://cdn.hamplard.com/paths/fashion.jpg',
  })
  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  /**
   * Optional initial ordered course list (course IDs). Position = array index.
   * Courses can also be set later via PUT /learning-paths/:id/courses.
   */
  @ApiPropertyOptional({
    description: 'Ordered course IDs for the path (index = position)',
    type: [String],
    example: ['course-101', 'course-102'],
  })
  @IsOptional()
  @IsArray({ each: false })
  @IsString({ each: true })
  courseIds?: string[];
}
