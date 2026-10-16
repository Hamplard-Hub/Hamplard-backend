import { Test, TestingModule } from '@nestjs/testing';
import { SmsController } from './sms.controller';
import { SmsService } from './sms.service';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

describe('SmsController Webhook Signature Verification', () => {
  let controller: SmsController;
  let smsService: SmsService;

  const mockSmsService = {
    sendSms: jest.fn(),
    getDeliveryStatus: jest.fn(),
    handleDeliveryCallback: jest.fn().mockResolvedValue({ acknowledged: true }),
    verifyWebhookSignature: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SmsController],
      providers: [
        {
          provide: SmsService,
          useValue: mockSmsService,
        },
      ],
    }).compile();

    controller = module.get<SmsController>(SmsController);
    smsService = module.get<SmsService>(SmsService);
    jest.clearAllMocks();
  });

  it('rejects unsigned callback requests with UnauthorizedException (401)', async () => {
    mockSmsService.verifyWebhookSignature.mockReturnValue(false);

    expect(() =>
      controller.handleCallback(undefined as any, {
        id: 'msg-1',
        status: 'Success',
      }),
    ).toThrow(UnauthorizedException);

    expect(mockSmsService.handleDeliveryCallback).not.toHaveBeenCalled();
  });

  it('rejects callback requests with invalid signature with UnauthorizedException (401)', async () => {
    mockSmsService.verifyWebhookSignature.mockReturnValue(false);

    expect(() =>
      controller.handleCallback('invalid-signature', {
        id: 'msg-1',
        status: 'Success',
      }),
    ).toThrow(UnauthorizedException);

    expect(mockSmsService.handleDeliveryCallback).not.toHaveBeenCalled();
  });

  it('processes callback requests with valid signature', async () => {
    mockSmsService.verifyWebhookSignature.mockReturnValue(true);

    const payload = { id: 'msg-1', status: 'Success' };
    const res = await controller.handleCallback('valid-signature', payload);

    expect(res).toEqual({ acknowledged: true });
    expect(mockSmsService.handleDeliveryCallback).toHaveBeenCalledWith(payload);
  });
});

describe('SmsService.verifyWebhookSignature', () => {
  let service: SmsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsService,
        {
          provide: require('../../common/prisma/prisma.service').PrismaService,
          useValue: {},
        },
        {
          provide: require('@nestjs/config').ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'SMS_WEBHOOK_SECRET') return 'my-webhook-secret';
              if (key === 'AFRICASTALKING_API_KEY') return 'test-api-key';
              if (key === 'AFRICASTALKING_USERNAME') return 'sandbox';
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<SmsService>(SmsService);
  });

  it('verifies matching HMAC signature correctly', () => {
    const payload = { id: 'msg-123', status: 'Success' };
    const validSignature = crypto
      .createHmac('sha256', 'my-webhook-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    expect(service.verifyWebhookSignature(validSignature, payload)).toBe(true);
  });

  it('fails verification on mismatched signature or payload', () => {
    const payload = { id: 'msg-123', status: 'Success' };
    const wrongSignature = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    expect(service.verifyWebhookSignature(wrongSignature, payload)).toBe(false);
    expect(service.verifyWebhookSignature(undefined, payload)).toBe(false);
  });
});
