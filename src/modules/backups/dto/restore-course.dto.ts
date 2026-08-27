import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LessonType } from '@prisma/client';

export class RestoreLessonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: LessonType })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  videoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  videoDuration?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resourceUrl?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  position: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;
}

export class RestoreModuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  position: number;

  @ApiPropertyOptional({ type: [RestoreLessonDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RestoreLessonDto)
  lessons?: RestoreLessonDto[];
}

export class RestoreCourseBackupDto {
  @ApiProperty({ description: 'Course id (on-chain / catalog id)' })
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  instructorAddress: string;

  @ApiProperty()
  @IsString()
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsString()
  category: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  level?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  previewVideoUrl?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  platformFeePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ type: [RestoreModuleDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RestoreModuleDto)
  modules?: RestoreModuleDto[];
}

export class RestoreCoursesDto {
  @ApiProperty({ type: [RestoreCourseBackupDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RestoreCourseBackupDto)
  courses: RestoreCourseBackupDto[];

  @ApiPropertyOptional({
    description: 'ISO datetime to run the restore later; omit for immediate',
  })
  @IsOptional()
  @IsDateString()
  scheduledFor?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'When true, overwrite existing course content from backup',
  })
  @IsOptional()
  @IsBoolean()
  overwriteExisting?: boolean;
}
