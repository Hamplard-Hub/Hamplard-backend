import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Request, Response } from 'express';
import { GoogleAuthService, GoogleIdentity } from './google-auth.service';
import { GoogleAuthGuard } from './google-auth.guard';
import { FeatureFlagGuard } from '../feature-flags/feature-flag.guard';
import { RequireFeature } from '../feature-flags/require-feature.decorator';

class GoogleTokenDto {
  @ApiProperty({ description: 'Google ID token returned by Google Sign-In' })
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @ApiProperty({
    required: false,
    description: 'TOTP or recovery code — required when the account has 2FA enabled',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}

class AuthCodeDto {
  @ApiProperty({ description: 'Short-lived one-time code issued at the OAuth callback' })
  @IsString()
  @IsNotEmpty()
  code: string;
}

@ApiTags('auth')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly googleAuth: GoogleAuthService) {}

  /** Step 1 — Redirect the browser to Google's consent screen. */
  @Get()
  @RequireFeature('google_login')
  @UseGuards(FeatureFlagGuard, GoogleAuthGuard)
  @ApiOperation({ summary: 'Start Google OAuth sign-in' })
  start() {}

  /**
   * Step 2 — Google redirects back here.
   * Instead of returning raw tokens in the JSON body (open to interception),
   * we issue a short-lived one-time code and redirect the browser to the
   * frontend, which exchanges the code for tokens via POST /auth/google/exchange.
   */
  @Get('callback')
  @RequireFeature('google_login')
  @UseGuards(FeatureFlagGuard, GoogleAuthGuard)
  @ApiOperation({ summary: 'Handle the Google OAuth callback and redirect to the frontend' })
  async callback(
    @Req() request: Request & { user: GoogleIdentity },
    @Res() response: Response,
  ) {
    const tokens = await this.googleAuth.login(request.user, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    // Wrap the token pair in a short-lived one-time code; the frontend
    // exchanges it immediately and the code is deleted after first use.
    const code = await this.googleAuth.createAuthCode(tokens);
    return response.redirect(this.googleAuth.getFrontendCallbackUrl(code));
  }

  /**
   * Step 3 — The frontend exchanges the one-time code for tokens.
   * Codes are single-use and expire in 60 seconds.
   */
  @Post('exchange')
  @RequireFeature('google_login')
  @UseGuards(FeatureFlagGuard)
  @ApiOperation({
    summary: 'Exchange a one-time OAuth callback code for access and refresh tokens',
  })
  async exchange(@Body() dto: AuthCodeDto) {
    const tokens = await this.googleAuth.consumeAuthCode(dto.code);
    if (!tokens) {
      throw new UnauthorizedException('Invalid or expired authorization code');
    }
    return tokens;
  }

  /**
   * Alternative sign-in for native / SPA clients that already hold a Google
   * ID token (e.g. One Tap).  Supports 2FA-enabled accounts via `totpCode`.
   */
  @Post('token')
  @RequireFeature('google_login')
  @UseGuards(FeatureFlagGuard)
  @ApiOperation({ summary: 'Validate a Google ID token and receive a platform JWT' })
  loginWithToken(@Body() dto: GoogleTokenDto, @Req() request: Request) {
    const deviceMeta = {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    };

    if (dto.totpCode) {
      return this.googleAuth.loginWithIdTokenAndTotp(dto.idToken, dto.totpCode, deviceMeta);
    }
    return this.googleAuth.loginWithIdToken(dto.idToken, deviceMeta);
  }
}