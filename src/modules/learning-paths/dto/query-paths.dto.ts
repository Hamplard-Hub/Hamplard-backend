import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class QueryPathsDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page (max 50)', example: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Case-insensitive title search' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Status filter — admins only (non-admins always see PUBLISHED)',
    enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
  status?: string;
}
