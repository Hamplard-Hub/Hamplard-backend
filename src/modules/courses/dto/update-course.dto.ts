import { IsString, IsOptional, IsNumber, Min, IsUrl } from 'class-validator';
import { getUrlValidationOptions } from '../../../common/validators/url-validation';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCourseDto {
  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() title?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() category?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() level?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() language?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsUrl(getUrlValidationOptions()) thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsUrl(getUrlValidationOptions()) previewVideoUrl?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; price changes require admin review for ACTIVE courses and must remain aligned with on-chain pricing.' })
  @IsOptional() @IsNumber() @Min(0) price?: number;
}
