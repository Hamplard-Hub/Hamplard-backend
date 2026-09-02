import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchQueryDto {
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

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
