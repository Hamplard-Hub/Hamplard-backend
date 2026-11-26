import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SubmitCourseDto {
  @ApiPropertyOptional({ description: 'On-chain course registration transaction hash' })
  @IsOptional()
  @IsString()
  txHash?: string;
}
