import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum EngagementScope {
  /** A single student across all of their enrollments. */
  STUDENT = 'STUDENT',
  /** Every student enrolled in one course (a cohort). */
  COURSE = 'COURSE',
  /** The whole platform. */
  PLATFORM = 'PLATFORM',
}

export class EngagementReportQueryDto {
  @ApiPropertyOptional({
    enum: EngagementScope,
    default: EngagementScope.PLATFORM,
    description:
      'Reporting scope. STUDENT requires studentId, COURSE requires courseId.',
  })
  @IsOptional()
  @IsEnum(EngagementScope)
  scope: EngagementScope = EngagementScope.PLATFORM;

  @ApiPropertyOptional({ description: 'Required when scope=STUDENT' })
  @IsOptional()
  @IsString()
  studentId?: string;

  @ApiPropertyOptional({ description: 'Required when scope=COURSE' })
  @IsOptional()
  @IsString()
  courseId?: string;

  @ApiPropertyOptional({
    description: 'Start of the reporting period (ISO-8601). Inclusive.',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the reporting period (ISO-8601). Inclusive.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    description:
      'A student with no lesson activity for this many days is flagged inactive.',
    default: 14,
    minimum: 1,
    maximum: 365,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  inactiveDays = 14;
}
