import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

export class CreateTagDto {
  /**
   * Display label shown to users — e.g. "Web Design".
   * Must be 2–50 characters.
   */
  @ApiProperty({
    description: 'Human-readable tag label shown to users',
    example: 'Web Design',
    minLength: 2,
    maxLength: 50,
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  // Allow letters (including accented/unicode), digits, spaces, hyphens, and ampersands
  @Matches(/^[\p{L}\p{N}\s\-&]+$/u, {
    message: 'label may only contain letters, digits, spaces, hyphens, and ampersands',
  })
  label: string;
}
