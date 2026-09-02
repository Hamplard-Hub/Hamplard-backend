import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CronJobStatus } from '@prisma/client';

export class QueryCronRunsDto {
  @ApiPropertyOptional({ description: 'Filter by job name' })
  @IsOptional()
  @IsString()
  jobName?: string;

  @ApiPropertyOptional({ enum: CronJobStatus, description: 'Filter by run status' })
  @IsOptional()
  @IsEnum(CronJobStatus)
  status?: CronJobStatus;

  @ApiPropertyOptional({ description: 'ISO date-time lower bound for startedAt' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date-time upper bound for startedAt' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}
