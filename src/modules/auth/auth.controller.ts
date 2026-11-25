import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus, Req, Headers, UseGuards, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LinkWalletNonceDto, LinkWalletVerifyDto } from './dto/link-wallet.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditAction, AuditTargetType } from '@prisma/client';

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
  @ApiProperty({
    required: false,
    example: '123456',
    description: 'TOTP or recovery code, required when the account has 2FA enabled',
  })
  @IsOptional() @IsString() totpCode?: string;
}

class RefreshTokenDto {
  @ApiProperty({ description: 'Current refresh token to exchange for a new pair' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

class User {
  id: string;
  stellarAddress: string | null;
  googleId: string | null;
  role: string;
}

@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly captchaService: CaptchaService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('nonce')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Get challenge nonce for a Stellar address after CAPTCHA verification',
    description: 'Rate limit: 10 requests per minute per IP.',
  })
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
    return { nonce: await this.authService.generateNonce(address), address };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Submit signed nonce and receive JWT access and refresh tokens',
    description: 'Rate limit: 5 requests per minute per IP.',
  })
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

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out this session and revoke its refresh-token family' })
  logout(@CurrentUser('id') userId: string, @CurrentUser('jti') jti?: string) {
    return this.authService.logout(userId, jti);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out all sessions and revoke all refresh-token families' })
  logoutAll(@CurrentUser('id') userId: string) {
    return this.authService.logoutAll(userId);
  }

  @Post('wallet/link-nonce')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a nonce to sign for linking a wallet to a Google account' })
  async getLinkNonce(@CurrentUser() user: User, @Body() dto: LinkWalletNonceDto, @Req() req: Request) {
    if (!user.googleId) {
      throw new BadRequestException('Wallet linking is only available for Google accounts');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { stellarAddress: dto.stellarAddress },
    });

    if (existingUser && existingUser.id !== user.id) {
      throw new BadRequestException('This wallet is already linked to another account');
    }

    const nonce = await this.authService.generateNonce(dto.stellarAddress);
    return { nonce, stellarAddress: dto.stellarAddress };
  }

  @Post('wallet/link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify wallet ownership and link it to the authenticated Google account' })
  async linkWallet(@CurrentUser() user: User, @Body() dto: LinkWalletVerifyDto, @Req() req: Request) {
    if (!user.googleId) {
      throw new BadRequestException('Wallet linking is only available for Google accounts');
    }

    const isValid = this.authService.verifySignature(dto.stellarAddress, dto.nonce, dto.signature);
    if (!isValid) {
      throw new BadRequestException('Invalid signature');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { stellarAddress: dto.stellarAddress },
    });

    if (existingUser && existingUser.id !== user.id) {
      throw new BadRequestException('This wallet is already linked to another account');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { stellarAddress: dto.stellarAddress },
    });

    // Audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: user.id,
        action: AuditAction.USER_ROLE_CHANGED,
        targetType: AuditTargetType.USER,
        targetId: user.id,
        metadata: { action: 'wallet_linked', stellarAddress: dto.stellarAddress },
        ipAddress: req.ip,
      },
    });

    return { success: true, stellarAddress: dto.stellarAddress };
  }

  @Post('wallet/unlink')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlink the wallet from a Google account' })
  async unlinkWallet(@CurrentUser() user: User, @Req() req: Request) {
    if (!user.googleId) {
      throw new BadRequestException('Wallet unlinking is only available for Google accounts');
    }

    if (!user.stellarAddress) {
      throw new BadRequestException('No wallet is currently linked');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { stellarAddress: null },
    });

    return { success: true };
  }
}
