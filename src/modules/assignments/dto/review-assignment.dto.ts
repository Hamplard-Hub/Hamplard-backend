import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';

export class ReviewAssignmentDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  approved: boolean;

  @ApiProperty({ example: 'Great work!' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  feedback: string;
}
