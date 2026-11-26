import { IsNotEmpty, IsString, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Issue #436 — validate the thumbnail URL instead of trusting a raw body. */
export class UpdateLessonThumbnailDto {
  @ApiProperty({
    description: 'Absolute URL of the lesson thumbnail image',
    example: 'https://cdn.example.com/thumbnails/lesson-1.jpg',
  })
  @IsString()
  @IsNotEmpty()
  @IsUrl()
  thumbnailUrl: string;
}
