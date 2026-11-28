import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class RecordLessonProgressDto {
  @ApiProperty({ description: 'ID of the enrollment' })
  @IsNotEmpty()
  @IsString()
  enrollmentId: string;

  @ApiProperty({ description: 'Number of seconds watched' })
  @IsNumber()
  @Min(0)
  watchedSecs: number;
}
