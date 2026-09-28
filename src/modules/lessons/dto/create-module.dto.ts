import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateModuleDto {
  @ApiProperty({ description: 'ID of the course this module belongs to', example: 'course-uuid-1' })
  @IsString()
  @IsNotEmpty()
  courseId: string;

  @ApiProperty({ description: 'Module title', example: 'Module 1: Introduction' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Ordering position within the course', example: 1 })
  @IsInt()
  @Min(0)
  position: number;
}
