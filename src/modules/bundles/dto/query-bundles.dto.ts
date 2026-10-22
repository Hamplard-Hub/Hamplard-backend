import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryBundlesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by instructor address' })
  @IsOptional()
  @IsString()
  instructorAddress?: string;
}
