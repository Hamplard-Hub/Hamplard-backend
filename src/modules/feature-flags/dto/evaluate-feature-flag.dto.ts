import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EvaluateFeatureFlagDto {
  @ApiPropertyOptional({
    description: 'User ID to evaluate the flag for (deterministic rollout)',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description: 'User role to check against allowedRoles (STUDENT | INSTRUCTOR | ADMIN)',
    example: 'STUDENT',
  })
  @IsOptional()
  @IsString()
  role?: string;
}
