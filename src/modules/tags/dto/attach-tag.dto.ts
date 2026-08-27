import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AttachTagDto {
  /**
   * ID of the course to attach the tag to.
   */
  @ApiProperty({
    description: 'Course ID to attach this tag to',
    example: 'course-uuid-here',
  })
  @IsNotEmpty()
  @IsString()
  courseId: string;
}
