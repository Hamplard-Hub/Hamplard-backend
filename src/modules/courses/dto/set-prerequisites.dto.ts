import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class SetPrerequisitesDto {
  /**
   * Full replacement list of course IDs that must be COMPLETED before
   * this course can be enrolled in. An empty array clears all prerequisites.
   */
  @ApiProperty({
    description:
      'Ordered-agnostic list of prerequisite course IDs (empty array clears all). ' +
      'The resulting global prerequisite graph must stay acyclic.',
    type: [String],
    example: ['course-101'],
    maxItems: 20,
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  prerequisiteIds: string[];
}
