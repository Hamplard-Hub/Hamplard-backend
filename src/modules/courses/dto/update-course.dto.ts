import { IsString, IsOptional, IsNumber, Min, IsUrl } from 'class-validator';
import { getUrlValidationOptions } from '../../../common/validators/url-validation';

export class UpdateCourseDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() level?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsUrl(getUrlValidationOptions()) thumbnailUrl?: string;
  @IsOptional() @IsUrl(getUrlValidationOptions()) previewVideoUrl?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
}
