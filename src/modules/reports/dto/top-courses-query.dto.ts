// dto/top-courses-query.dto.ts
import { IsEnum, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum TopCoursesMetric {
  ENROLLMENTS     = 'ENROLLMENTS',
  REVENUE         = 'REVENUE',
  COMPLETION_RATE = 'COMPLETION_RATE',
}

export enum TopCoursesWindow {
  LAST_7_DAYS  = '7d',
  LAST_30_DAYS = '30d',
  LAST_90_DAYS = '90d',
  ALL_TIME     = 'all',
}

export class TopCoursesQueryDto {
  @ApiPropertyOptional({
    enum: TopCoursesMetric,
    default: TopCoursesMetric.ENROLLMENTS,
    description: 'Metric used to rank courses',
  })
  @IsOptional() @IsEnum(TopCoursesMetric)
  metric?: TopCoursesMetric = TopCoursesMetric.ENROLLMENTS;

  @ApiPropertyOptional({
    enum: TopCoursesWindow,
    default: TopCoursesWindow.ALL_TIME,
    description: 'Time window the ranking is computed over',
  })
  @IsOptional() @IsEnum(TopCoursesWindow)
  window?: TopCoursesWindow = TopCoursesWindow.ALL_TIME;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 10;
}
