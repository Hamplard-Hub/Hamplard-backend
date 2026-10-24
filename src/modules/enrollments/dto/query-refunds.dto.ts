import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { RefundStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryRefundsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus, description: 'Filter by refund status' })
  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;
}
