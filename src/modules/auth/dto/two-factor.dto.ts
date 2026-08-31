// dto/two-factor.dto.ts
import { IsString, IsNotEmpty, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EnableTwoFactorDto {
  @ApiProperty({ example: '123456', description: 'Current TOTP code from the authenticator app' })
  @IsString() @IsNotEmpty() @Length(6, 6)
  code: string;
}

export class DisableTwoFactorDto {
  @ApiProperty({ example: '123456', description: 'Current TOTP code or an unused recovery code' })
  @IsString() @IsNotEmpty()
  code: string;
}
