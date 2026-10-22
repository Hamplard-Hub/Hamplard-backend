import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { FraudFlagStatus, FraudRiskLevel } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryFraudQueueDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FraudFlagStatus, description: 'Filter by fraud flag status' })
  @IsOptional()
  @IsEnum(FraudFlagStatus)
  status?: FraudFlagStatus;

  @ApiPropertyOptional({ enum: FraudRiskLevel, description: 'Filter by risk level' })
  @IsOptional()
  @IsEnum(FraudRiskLevel)
  riskLevel?: FraudRiskLevel;
}
