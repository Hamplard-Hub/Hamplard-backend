import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectCourseDto {
  @ApiProperty({ description: 'Feedback reason for rejecting the course' })
  @IsNotEmpty()
  @IsString()
  reason: string;
}
