import { Controller, Post, Get, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('otp')
@UseGuards(JwtAuthGuard)
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  /**
   * POST /api/v1/otp/send
   * Generate and send OTP to user's phone number
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async sendOtp(
    @CurrentUser('sub') userId: string,
    @Body() dto: SendOtpDto,
  ): Promise<{ message: string }> {
    await this.otpService.sendOtp(userId, dto.phoneNumber, dto.countryCode);
    return {
      message: 'OTP sent successfully. Please check your phone.',
    };
  }

  /**
   * POST /api/v1/otp/verify
   * Verify OTP submitted by user
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @CurrentUser('sub') userId: string,
    @Body() dto: VerifyOtpDto,
  ): Promise<{ message: string; verified: boolean }> {
    const verified = await this.otpService.verifyOtp(userId, dto.phoneNumber, dto.otp);
    return {
      message: 'Phone number verified successfully',
      verified,
    };
  }

  /**
   * GET /api/v1/otp/status
   * Get phone verification status for current user
   */
  @Get('status')
  async getStatus(@CurrentUser('sub') userId: string) {
    return this.otpService.getVerificationStatus(userId);
  }
}
