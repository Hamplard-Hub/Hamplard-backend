import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { Request } from 'express';
import { GoogleAuthService, GoogleIdentity } from './google-auth.service';
import { GoogleAuthGuard } from './google-auth.guard';

class GoogleTokenDto {
  @ApiProperty({ description: 'Google ID token returned by Google Sign-In' })
  @IsString()
  @IsNotEmpty()
  idToken: string;
}

@ApiTags('auth')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly googleAuth: GoogleAuthService) {}

  @Get()
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Start Google OAuth sign-in' })
  start() {}

  @Get('callback')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Handle the Google OAuth callback' })
  callback(@Req() request: Request & { user: GoogleIdentity }) {
    return this.googleAuth.login(request.user);
  }

  @Post('token')
  @ApiOperation({ summary: 'Validate a Google ID token and receive a platform JWT' })
  loginWithToken(@Body() dto: GoogleTokenDto) {
    return this.googleAuth.loginWithIdToken(dto.idToken);
  }
}