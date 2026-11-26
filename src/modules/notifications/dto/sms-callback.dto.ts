import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SmsCallbackDto {
  @ApiProperty({ description: 'SMS message identifier' })
  @IsNotEmpty()
  @IsString()
  id: string;

  @ApiProperty({ description: 'Delivery status string' })
  @IsNotEmpty()
  @IsString()
  status: string;

  @ApiPropertyOptional({ description: 'Recipient phone number' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;
}
