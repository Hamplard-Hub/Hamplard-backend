import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEnrollmentDto {
  @ApiProperty({ description: 'Course the student paid for' })
  @IsString() @IsNotEmpty()
  courseId: string;

  @ApiProperty({ description: 'Hash of the confirmed on-chain enroll() transaction' })
  @IsString() @IsNotEmpty()
  txHash: string;

  @ApiProperty({ description: 'Checkout quote id from POST /checkout/quote — the paid amount must equal its total' })
  @IsString() @IsNotEmpty()
  quoteId: string;
}
