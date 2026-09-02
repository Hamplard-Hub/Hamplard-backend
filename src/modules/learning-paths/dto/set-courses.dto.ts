import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
} from 'class-validator';

export class SetPathCoursesDto {
  /**
   * Fully replaces the path's course list. Array order = course order
   * within the path (index 0 is taken first).
   */
  @ApiProperty({
    description: 'Ordered course IDs (index = position). Replaces the existing list.',
    type: [String],
    example: ['course-101', 'course-102', 'course-103'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  courseIds: string[];
}
