import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CourseStatus } from '@prisma/client';

/** Statuses an instructor/admin may move a course to via the status endpoint (#331). */
export const MANUAL_COURSE_STATUSES = [
  CourseStatus.ACTIVE,
  CourseStatus.PAUSED,
  CourseStatus.ARCHIVED,
] as const;

export type ManualCourseStatus = (typeof MANUAL_COURSE_STATUSES)[number];

export class ChangeCourseStatusDto {
  @ApiProperty({
    description:
      'Target status. PAUSED unpublishes the course (hidden from catalog/search), ' +
      'ARCHIVED retires it permanently, ACTIVE republishes a paused course. ' +
      'Enrolled students keep access to PAUSED and ARCHIVED courses.',
    enum: MANUAL_COURSE_STATUSES,
    example: CourseStatus.ARCHIVED,
  })
  @IsIn(MANUAL_COURSE_STATUSES)
  status: ManualCourseStatus;

  @ApiPropertyOptional({ description: 'Optional reason, recorded in the audit log for admin actions' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
