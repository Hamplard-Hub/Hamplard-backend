import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus, Req, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class LoginDto {
  @ApiProperty() @IsString() @IsNotEmpty() stellarAddress: string;
  @ApiProperty() @IsString() @IsNotEmpty() signedNonce: string;
  @ApiProperty() @IsString() @IsNotEmpty() signature: string;
  @ApiProperty({ required: false, enum: ['STUDENT', 'INSTRUCTOR'] })
  @IsOptional() @IsIn(['STUDENT', 'INSTRUCTOR']) role?: 'STUDENT' | 'INSTRUCTOR';
  @ApiProperty({
    required: false,
    example: 'HAMP-A1B2C3',
    description: 'Optional referral code applied on first-time registration',
  })
  @IsOptional() @IsString() referralCode?: string;
}

class RefreshTokenDto {
  @ApiProperty({ description: 'Current refresh token to exchange for a new pair' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly captchaService: CaptchaService,
  ) {}

  @Get('nonce')
  @ApiOperation({ summary: 'Get challenge nonce for a Stellar address after CAPTCHA verification' })
  @ApiQuery({ name: 'address', required: true })
  @ApiQuery({
    name: 'captchaToken',
    required: true,
    description: 'CAPTCHA token from the configured provider. May also be sent as x-captcha-token.',
  })
  async getNonce(
    @Query('address') address: string,
    @Query('captchaToken') captchaToken: string,
    @Req() req: Request,
    @Headers('x-captcha-token') captchaHeader?: string,
  ) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    await this.captchaService.verifyBeforeNonce(captchaToken || captchaHeader, ip);
    return { nonce: this.authService.generateNonce(address), address };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit signed nonce and receive JWT access and refresh tokens' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new access and refresh token pair' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }
}
