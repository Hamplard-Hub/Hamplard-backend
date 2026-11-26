// dto/create-course.dto.ts
import {
  IsString, IsNotEmpty, IsOptional, IsNumber,
  IsInt, Min, Max, IsUrl,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { getUrlValidationOptions } from '../../../common/validators/url-validation';

export class CreateCourseDto {
  @ApiProperty({ example: 'COURSE-TAILORING-001' })
  @IsString() @IsNotEmpty()
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

  @ApiProperty({ required: false, example: 'Beginner' })
  @IsOptional() @IsString()
  level?: string;

  @ApiProperty({ required: false, example: 'English' })
  @IsOptional() @IsString()
  language?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsUrl(getUrlValidationOptions())
  thumbnailUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsUrl(getUrlValidationOptions())
  previewVideoUrl?: string;

  @ApiProperty({ example: 50, description: 'Price in USDC' })
  @IsNumber() @Min(0)
  price: number;
}

