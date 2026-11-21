import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateLessonThumbnailDto {
  @ApiProperty({ description: 'URL for lesson thumbnail image' })
  @IsNotEmpty()
  @IsString()
  thumbnailUrl: string;
}
