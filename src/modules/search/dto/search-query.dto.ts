import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class SearchQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: 'Full-text search query' })
  @IsString()
  query: string;

  @ApiProperty({ required: false, description: 'Category filter' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, description: 'Level filter (Beginner, Intermediate, Advanced)' })
  @IsOptional()
  @IsString()
  level?: string;

  @ApiProperty({ required: false, description: 'Language filter' })
  @IsOptional()
  @IsString()
  language?: string;
}
