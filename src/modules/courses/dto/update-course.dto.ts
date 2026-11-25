import { IsString, IsOptional, IsNumber, Min } from 'class-validator';
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
  @IsOptional() @IsString() thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; changes require admin review for ACTIVE courses.' })
  @IsOptional() @IsString() previewVideoUrl?: string;

  @ApiPropertyOptional({ description: 'Editable while DRAFT/PENDING/PAUSED; price changes require admin review for ACTIVE courses and must remain aligned with on-chain pricing.' })
  @IsOptional() @IsNumber() @Min(0) price?: number;
}
