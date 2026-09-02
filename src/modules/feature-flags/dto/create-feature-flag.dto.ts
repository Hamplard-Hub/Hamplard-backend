import {
  IsArray,
  IsBoolean,
  IsInt,
  IsJSON,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class CreateFeatureFlagDto {
  @ApiProperty({
    description:
      'Unique machine-readable key for the flag (snake_case, alphanumeric + underscores)',
    example: 'new_payment_flow',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'key must be lowercase alphanumeric with underscores only',
  })
  key: string;

  @ApiPropertyOptional({ description: 'Human-readable description of the flag' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Whether the flag is active',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Percentage of users (0–100) to expose the flag to when enabled',
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  rolloutPercent?: number;

  @ApiPropertyOptional({
    description:
      'Restrict the flag to these roles only (STUDENT | INSTRUCTOR | ADMIN). Empty = no role restriction.',
    type: [String],
    example: ['ADMIN', 'INSTRUCTOR'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedRoles?: string[];

  @ApiPropertyOptional({
    description:
      'Explicit allow-list of user IDs regardless of rollout percentage',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedUserIds?: string[];

  @ApiPropertyOptional({
    description: 'Arbitrary JSON metadata for flag configuration',
    example: { variant: 'A', minVersion: '2.1.0' },
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'object' ? value : JSON.parse(value),
  )
  metadata?: Record<string, unknown>;
}
