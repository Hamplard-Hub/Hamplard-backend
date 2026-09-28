import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class IssueCertificateDto {
  @ApiProperty({ description: 'ID of the student receiving the certificate' })
  @IsUUID()
  @IsNotEmpty()
  studentId: string;

  @ApiProperty({ description: 'ID of the course completed' })
  @IsUUID()
  @IsNotEmpty()
  courseId: string;
}

export class UpdateCertificateTxHashDto {
  @ApiProperty({ description: 'On-chain transaction hash for the certificate issuance' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message: 'txHash must be a 64-character hexadecimal string',
  })
  txHash: string;
}

export class RevokeCertificateDto {
  @ApiPropertyOptional({ description: 'Reason for revoking the certificate' })
  @IsOptional()
  @IsString()
  reason?: string;
}
