import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ReindexSearchDto {
  @ApiProperty({
    required: false,
    default: 500,
    description: 'Number of courses sent to Meilisearch per batch',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  batchSize?: number;
}
