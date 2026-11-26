import { IsString, IsNotEmpty, IsOptional, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateModuleDto {
  @ApiPropertyOptional({ description: 'Module title', example: 'Module 1: Introduction' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiPropertyOptional({ description: 'Ordering position within the course', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
