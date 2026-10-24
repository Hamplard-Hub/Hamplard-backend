import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryTagsDto extends PaginationQueryDto {
  /**
   * Free-text search against the tag label.
   */
  @ApiPropertyOptional({
    description: 'Filter tags by label (case-insensitive partial match)',
    example: 'design',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
