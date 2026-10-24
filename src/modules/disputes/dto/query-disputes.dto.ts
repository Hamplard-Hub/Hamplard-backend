import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { DisputeStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryDisputesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus, description: 'Filter by dispute status' })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}
