import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export const REJECTION_REASON_MIN_LENGTH = 10;
export const REJECTION_REASON_MAX_LENGTH = 2000;

/** Issue #444 — body for POST /courses/:id/reject. */
export class RejectCourseDto {
  @ApiProperty({
    description: 'Feedback shown to the instructor explaining what must change before approval.',
    example: 'The intro video is missing and module 2 has no lessons.',
    minLength: REJECTION_REASON_MIN_LENGTH,
    maxLength: REJECTION_REASON_MAX_LENGTH,
  })
  // Read the raw input (`obj`) rather than `value`: the global pipe's implicit
  // conversion would otherwise coerce numbers/objects into strings such as
  // "[object Object]" that slip past the length check.
  @Transform(({ obj, key }) => (typeof obj[key] === 'string' ? obj[key].trim() : obj[key]))
  @IsString()
  @IsNotEmpty()
  @MinLength(REJECTION_REASON_MIN_LENGTH)
  @MaxLength(REJECTION_REASON_MAX_LENGTH)
  reason: string;
}
