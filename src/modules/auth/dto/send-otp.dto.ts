import { IsString, IsNotEmpty, Matches, Length } from 'class-validator';

export class SendOtpDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{1,14}$/, {
    message: 'Phone number must be in E.164 format (e.g., +254712345678)',
  })
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 3)
  countryCode: string;
}
