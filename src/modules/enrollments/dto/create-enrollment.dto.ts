import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class CreateEnrollmentDto {
  @ApiProperty({ description: 'ID of the course enrolled in' })
  @IsNotEmpty()
  @IsString()
  courseId: string;

  @ApiProperty({ description: 'On-chain transaction hash' })
  @IsNotEmpty()
  @IsString()
  txHash: string;

  @ApiProperty({ description: 'Amount paid in USDC' })
  @IsNumber()
  @Min(0)
  amountPaid: number;
}
