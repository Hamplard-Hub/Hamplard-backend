import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { ToOptionalBool } from '../../../common/pipes/parse-optional-bool';

export class QueryCouponsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by active state ("true"/"false"/"1"/"0")' })
  @IsOptional()
  @ToOptionalBool()
  @IsBoolean()
  isActive?: boolean;
}
