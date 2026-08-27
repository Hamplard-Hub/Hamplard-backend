import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class MergeTagsDto {
  /**
   * IDs of the source tags that will be merged away and deleted.
   * Must contain at least one ID. The target tag (identified by the
   * route param) will absorb all course associations from these tags,
   * and its usageCount will be recalculated accordingly.
   */
  @ApiProperty({
    description:
      'IDs of the duplicate tags to merge into the target tag. These tags will be deleted after the merge.',
    example: ['uuid-source-1', 'uuid-source-2'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsString({ each: true })
  sourceTagIds: string[];
}
