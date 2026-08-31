import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EmailVerificationService } from './email-verification.service';

@ApiTags('auth')
@Controller('auth/email-verification')
export class EmailVerificationController {
  constructor(
    private readonly verificationService: EmailVerificationService,
  ) {}

  @Post('request')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request email verification link' })
  requestVerification(@CurrentUser('id') userId: string) {
    return this.verificationService.requestVerification(userId);
  }

  @Get('confirm')
  @ApiOperation({ summary: 'Confirm email verification via token' })
  @ApiQuery({ name: 'token', description: 'Signed verification token' })
  confirmVerification(@Query('token') token: string) {
    return this.verificationService.confirmVerification(token);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get email verification status' })
  getVerificationStatus(@CurrentUser('id') userId: string) {
    return this.verificationService.getVerificationStatus(userId);
  }
}
