import { IsString, IsOptional, IsNumber, Min } from 'class-validator';

export class UpdateCourseDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() level?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() thumbnailUrl?: string;
  @IsOptional() @IsString() previewVideoUrl?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
}
