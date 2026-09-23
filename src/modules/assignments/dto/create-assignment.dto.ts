import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';

export class CreateAssignmentDto {
  @ApiProperty({ example: 'Lesson1' })
  @IsString()
  lessonId: string;

  @ApiProperty({ example: 'Practical Sewing Task' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiProperty({ example: 'Create a sewn garment piece' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description: string;

  @ApiPropertyOptional({ example: 'Step-by-step instructions...' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string;
}
