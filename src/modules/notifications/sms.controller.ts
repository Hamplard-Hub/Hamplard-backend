import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SmsService } from './sms.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole, SmsTemplateKey } from '@prisma/client';

@ApiTags('sms')
@Controller('notifications/sms')
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  @Post('send')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send an SMS message for a critical account or enrollment alert' })
  sendSms(
    @Body('phoneNumber') phoneNumber: string,
    @Body('countryCode') countryCode: string,
    @Body('userId') userId?: string,
    @Body('templateKey') templateKey?: SmsTemplateKey,
    @Body('templateData') templateData?: Record<string, string | number>,
    @Body('message') message?: string,
  ) {
    return this.smsService.sendSms({ phoneNumber, countryCode, userId, templateKey, templateData, message });
  }

  @Get(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the delivery status of an SMS message' })
  getStatus(@Param('id') id: string) {
    return this.smsService.getDeliveryStatus(id);
  }

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delivery status callback invoked by the SMS gateway' })
  handleCallback(@Body() payload: { id: string; status: string; phoneNumber?: string }) {
    return this.smsService.handleDeliveryCallback(payload);
  }
}
