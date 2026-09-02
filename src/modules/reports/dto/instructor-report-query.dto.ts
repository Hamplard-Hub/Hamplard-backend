import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

export class InstructorReportQueryDto {
  @ApiPropertyOptional({
    description: 'Start of the reporting period (ISO-8601). Inclusive.',
    example: '2026-01-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the reporting period (ISO-8601). Inclusive.',
    example: '2026-06-30T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
