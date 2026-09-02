// dashboard-query.dto.ts — issue #61: admin dashboard summary stats
import { IsOptional, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DashboardQueryDto {
  @ApiPropertyOptional({ description: 'Start of the reporting period (ISO date). Must be paired with endDate.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End of the reporting period (ISO date). Must be paired with startDate.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
