import { Controller, Get, Post, Body, Query, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('nonce')
  @ApiOperation({ summary: 'Get challenge nonce for a Stellar address' })
  getNonce(@Query('address') address: string) {
    return { nonce: this.authService.generateNonce(address), address };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit signed nonce and receive JWT' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  }
}
