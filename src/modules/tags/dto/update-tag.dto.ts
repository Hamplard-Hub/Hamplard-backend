import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

export class UpdateTagDto {
  /**
   * New display label for the tag — e.g. "UI/UX Design".
   */
  @ApiPropertyOptional({
    description: 'Updated human-readable tag label',
    example: 'UI/UX Design',
    minLength: 2,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[\p{L}\p{N}\s\-&]+$/u, {
    message: 'label may only contain letters, digits, spaces, hyphens, and ampersands',
  })
  label?: string;
}
