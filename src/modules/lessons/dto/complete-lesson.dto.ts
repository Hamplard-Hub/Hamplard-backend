import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CompleteLessonDto {
  @ApiProperty({ description: 'ID of the enrollment' })
  @IsNotEmpty()
  @IsString()
  enrollmentId: string;

  @ApiPropertyOptional({ description: 'Number of seconds watched' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  watchedSecs?: number;
}
