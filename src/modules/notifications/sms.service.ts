import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SmsStatus, SmsTemplateKey } from '@prisma/client';

const COUNTRY_PHONE_PATTERNS: Record<string, RegExp> = {
  NG: /^(?:\+234|0)[789][01]\d{8}$/, // Nigeria
  KE: /^(?:\+254|0)[71]\d{8}$/, // Kenya
  UG: /^(?:\+256|0)7\d{8}$/, // Uganda
  GH: /^(?:\+233|0)[235]\d{8}$/, // Ghana
  ZA: /^(?:\+27|0)[678]\d{8}$/, // South Africa
  TZ: /^(?:\+255|0)[67]\d{8}$/, // Tanzania
};

const COUNTRY_DIAL_CODES: Record<string, string> = {
  NG: '234',
  KE: '254',
  UG: '256',
  GH: '233',
  ZA: '27',
  TZ: '255',
};

const SMS_TEMPLATES: Record<SmsTemplateKey, string> = {
  ACCOUNT_VERIFICATION:
    'Hi {{name}}, your Hamplard verification code is {{code}}. It expires in {{minutes}} minutes.',
  ENROLLMENT_CONFIRMED: 'Hi {{name}}, you are now enrolled in "{{courseTitle}}". Happy learning!',
  PAYMENT_RECEIVED: 'Hi {{name}}, we received your payment of {{amount}} for "{{courseTitle}}".',
  PASSWORD_RESET:
    'Hi {{name}}, your Hamplard password reset code is {{code}}. It expires in {{minutes}} minutes.',
  GENERIC_ALERT: '{{message}}',
};

interface SendSmsParams {
  phoneNumber: string;
  countryCode: string;
  userId?: string;
  templateKey?: SmsTemplateKey;
  templateData?: Record<string, string | number>;
  message?: string;
}

interface DeliveryCallbackPayload {
  id: string;
  status: string;
  phoneNumber?: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly gateway: any;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const africastalking = require('africastalking')({
      apiKey: this.config.get('AFRICASTALKING_API_KEY'),
      username: this.config.get('AFRICASTALKING_USERNAME', 'sandbox'),
    });
    this.gateway = africastalking.SMS;
  }

  /** Validates and normalizes a phone number against country-specific formats, returning it in E.164 form. */
  validatePhoneNumber(phoneNumber: string, countryCode: string): string {
    const country = countryCode?.toUpperCase();
    const pattern = COUNTRY_PHONE_PATTERNS[country];

    if (!pattern) {
      throw new BadRequestException(`Unsupported country code: ${countryCode}`);
    }

    const trimmed = phoneNumber?.trim();
    if (!trimmed || !pattern.test(trimmed)) {
      throw new BadRequestException(`Invalid phone number format for country ${country}`);
    }

    return this.toE164(trimmed, country);
  }

  renderTemplate(templateKey: SmsTemplateKey, data: Record<string, string | number> = {}): string {
    const template = SMS_TEMPLATES[templateKey];
    if (!template) {
      throw new BadRequestException(`Unknown SMS template: ${templateKey}`);
    }

    return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key) =>
      data[key] !== undefined ? String(data[key]) : `{{${key}}}`,
    );
  }

  async sendSms(params: SendSmsParams) {
    const normalizedPhone = this.validatePhoneNumber(params.phoneNumber, params.countryCode);
    const message = params.templateKey
      ? this.renderTemplate(params.templateKey, params.templateData)
      : params.message;

    if (!message) {
      throw new BadRequestException('Either a templateKey or a message must be provided');
    }

    const smsMessage = await this.prisma.smsMessage.create({
      data: {
        userId: params.userId,
        phoneNumber: normalizedPhone,
        countryCode: params.countryCode.toUpperCase(),
        templateKey: params.templateKey,
        message,
        status: SmsStatus.PENDING,
      },
    });

    try {
      const response = await this.gateway.send({
        to: [normalizedPhone],
        message,
        from: this.config.get('AFRICASTALKING_SENDER_ID'),
      });

      const recipient = response?.SMSMessageData?.Recipients?.[0];
      const providerMessageId = recipient?.messageId;
      const isSent = recipient?.status === 'Success';

      return this.prisma.smsMessage.update({
        where: { id: smsMessage.id },
        data: {
          status: isSent ? SmsStatus.SENT : SmsStatus.FAILED,
          providerMessageId,
          failureReason: isSent ? null : recipient?.status,
          sentAt: isSent ? new Date() : null,
        },
      });
    } catch (error) {
      this.logger.error(`SMS send failed to ${normalizedPhone}`, error.message);
      return this.prisma.smsMessage.update({
        where: { id: smsMessage.id },
        data: { status: SmsStatus.FAILED, failureReason: error.message },
      });
    }
  }

  async getDeliveryStatus(messageId: string) {
    return this.prisma.smsMessage.findUnique({ where: { id: messageId } });
  }

  /** Invoked by the SMS gateway's delivery report (DLR) webhook to update final delivery status. */
  async handleDeliveryCallback(payload: DeliveryCallbackPayload) {
    const record = await this.prisma.smsMessage.findUnique({
      where: { providerMessageId: payload.id },
    });

    if (!record) {
      this.logger.warn(`Delivery callback received for unknown message ${payload.id}`);
      return { acknowledged: false };
    }

    const normalizedStatus = payload.status?.toLowerCase();
    const isDelivered = normalizedStatus === 'success' || normalizedStatus === 'delivered';

    await this.prisma.smsMessage.update({
      where: { id: record.id },
      data: {
        status: isDelivered ? SmsStatus.DELIVERED : SmsStatus.FAILED,
        deliveredAt: isDelivered ? new Date() : null,
        failureReason: isDelivered ? null : payload.status,
      },
    });

    return { acknowledged: true };
  }

  private toE164(phoneNumber: string, country: string): string {
    if (phoneNumber.startsWith('+')) return phoneNumber;
    const dialCode = COUNTRY_DIAL_CODES[country];
    return `+${dialCode}${phoneNumber.replace(/^0/, '')}`;
  }
}
