import { IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LinkWalletNonceDto {
  @ApiProperty({ description: 'Stellar address to link' })
  @IsNotEmpty()
  @IsString()
  stellarAddress: string;
}

export class LinkWalletVerifyDto {
  @ApiProperty({ description: 'Stellar address to link' })
  @IsNotEmpty()
  @IsString()
  stellarAddress: string;

  @ApiProperty({ description: 'Signature of the nonce' })
  @IsNotEmpty()
  @IsString()
  signature: string;

  @ApiProperty({ description: 'Nonce that was signed' })
  @IsNotEmpty()
  @IsString()
  nonce: string;
}

export class UnlinkWalletDto {
  @ApiProperty({ description: 'Stellar address to unlink', required: false })
  @IsOptional()
  @IsString()
  stellarAddress?: string;
}