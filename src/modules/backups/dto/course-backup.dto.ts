import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import { CourseBackupStatus } from "@prisma/client";
import { RestoreCourseBackupDto } from "./restore-course.dto";

export class RequestCourseBackupDto {
  @ApiPropertyOptional({ description: "ID of the course to backup" })
  @IsOptional()
  @IsString()
  courseId?: string;
}

export class QueryCourseBackupsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: CourseBackupStatus })
  @IsOptional()
  @IsEnum(CourseBackupStatus)
  status?: CourseBackupStatus;

  @ApiPropertyOptional({ description: "Filter by automatic/scheduled backups" })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isAutomatic?: boolean;
}

export interface MissingElementInfo {
  moduleId: string;
  moduleTitle?: string;
  lessonId: string;
  lessonTitle: string;
  field: string;
  message: string;
}

export interface CourseBackupValidationReport {
  isComplete: boolean;
  errors: string[];
  warnings: string[];
  totalModules: number;
  totalLessons: number;
  totalVideoLessons: number;
  totalTextLessons: number;
  missingContentLessons: MissingElementInfo[];
  missingVideoLessons: MissingElementInfo[];
}

export interface CourseBackupExportPayload {
  formatVersion: string;
  courseBackupVersion: number;
  courseId: string;
  exportedAt: string;
  isAutomatic: boolean;
  requestedBy: string | null;
  checksum: string;
  course: RestoreCourseBackupDto;
  validationReport: CourseBackupValidationReport;
}
