import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{1,14}$/, {
    message: 'Phone number must be in E.164 format (e.g., +254712345678)',
  })
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, {
    message: 'OTP must be a 6-digit number',
  })
  otp: string;
}
