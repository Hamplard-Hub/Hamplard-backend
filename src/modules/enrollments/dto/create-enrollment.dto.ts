import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateEnrollmentDto {
  @ApiProperty({ description: 'ID of the course enrolled in' })
  @IsNotEmpty()
  @IsString()
  courseId: string;

  @ApiProperty({ description: 'On-chain transaction hash' })
  @IsNotEmpty()
  @IsString()
  txHash: string;

  @ApiPropertyOptional({ description: 'Amount paid in USDC' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amountPaid?: number;
}
