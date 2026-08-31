// two-factor.controller.ts
import { Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TwoFactorService } from './two-factor.service';
import { EnableTwoFactorDto, DisableTwoFactorDto } from './dto/two-factor.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
@Controller('auth/2fa')
export class TwoFactorController {
  constructor(private readonly twoFactorService: TwoFactorService) {}

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a TOTP secret and QR enrollment payload' })
  setup(@CurrentUser('id') userId: string) {
    return this.twoFactorService.generateSecret(userId);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm setup with a TOTP code and enable 2FA, issuing recovery codes' })
  enable(@CurrentUser('id') userId: string, @Body() dto: EnableTwoFactorDto) {
    return this.twoFactorService.enable(userId, dto.code);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA after re-confirming a TOTP or recovery code' })
  disable(@CurrentUser('id') userId: string, @Body() dto: DisableTwoFactorDto) {
    return this.twoFactorService.disable(userId, dto.code);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get the 2FA enabled state for the authenticated account' })
  status(@CurrentUser('id') userId: string) {
    return this.twoFactorService.getStatus(userId);
  }
}
