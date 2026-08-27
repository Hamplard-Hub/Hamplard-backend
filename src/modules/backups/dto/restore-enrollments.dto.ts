import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsBoolean,
  IsDateString,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EnrollmentStatus } from '@prisma/client';

export enum EnrollmentConflictStrategy {
  SKIP = 'SKIP',
  OVERWRITE = 'OVERWRITE',
  MERGE = 'MERGE',
}

export class RestoreLessonProgressDto {
  @ApiProperty()
  @IsString()
  lessonId: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  watchedSecs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  completedAt?: string;
}

export class RestoreEnrollmentRecordDto {
  @ApiPropertyOptional({ description: 'Original enrollment id from backup' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty()
  @IsUUID()
  studentId: string;

  @ApiProperty()
  @IsString()
  courseId: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  amountPaid: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  txHash?: string;

  @ApiPropertyOptional({ enum: EnrollmentStatus })
  @IsOptional()
  @IsEnum(EnrollmentStatus)
  status?: EnrollmentStatus;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  progressPercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  enrolledAt?: string;

  @ApiPropertyOptional({ type: [RestoreLessonProgressDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RestoreLessonProgressDto)
  lessonProgress?: RestoreLessonProgressDto[];
}

export class RestoreEnrollmentsDto {
  @ApiProperty({ type: [RestoreEnrollmentRecordDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RestoreEnrollmentRecordDto)
  enrollments: RestoreEnrollmentRecordDto[];

  @ApiPropertyOptional({
    enum: EnrollmentConflictStrategy,
    default: EnrollmentConflictStrategy.SKIP,
    description:
      'SKIP keeps existing records, OVERWRITE replaces them, MERGE updates fields preferring higher progress',
  })
  @IsOptional()
  @IsEnum(EnrollmentConflictStrategy)
  conflictStrategy?: EnrollmentConflictStrategy;
}
