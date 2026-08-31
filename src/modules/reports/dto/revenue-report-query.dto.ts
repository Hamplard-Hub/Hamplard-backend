// dto/revenue-report-query.dto.ts — issue #62: revenue report API
import { IsOptional, IsDateString, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RevenueReportQueryDto {
  @ApiPropertyOptional({ description: 'Start of the reporting period (ISO date). Must be paired with endDate.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End of the reporting period (ISO date). Must be paired with startDate.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Scope the report to a single instructor (User id)' })
  @IsOptional()
  @IsString()
  instructorId?: string;

  @ApiPropertyOptional({ description: 'Scope the report to a single course' })
  @IsOptional()
  @IsString()
  courseId?: string;

  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json', description: 'Include a ready-to-export CSV string alongside the JSON payload' })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
