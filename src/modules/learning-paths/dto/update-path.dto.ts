import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength, IsUrl } from 'class-validator';

export class UpdatePathDto {
  @ApiPropertyOptional({
    description: 'New human-readable learning path title',
    minLength: 3,
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ description: 'Updated path description', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Updated cover image URL' })
  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;
}
