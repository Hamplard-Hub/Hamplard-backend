import { IsUrl } from 'class-validator';

export class UpdateThumbnailDto {
  @IsUrl({}, { message: 'thumbnailUrl must be a valid URL' })
  thumbnailUrl: string;
}
