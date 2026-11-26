import { Test, TestingModule } from '@nestjs/testing';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

describe('OtpController', () => {
  let controller: OtpController;

  const mockOtpService = {
    sendOtp: jest.fn().mockResolvedValue(undefined),
    verifyOtp: jest.fn().mockResolvedValue(true),
    getVerificationStatus: jest.fn().mockResolvedValue({ verified: false }),
  };

  const userId = 'user-123';

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OtpController],
      providers: [{ provide: OtpService, useValue: mockOtpService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(OtpController);
  });

  it('passes the authenticated user id to OtpService.sendOtp', async () => {
    await controller.sendOtp(userId, { phoneNumber: '8012345678', countryCode: '+234' } as any);
    expect(mockOtpService.sendOtp).toHaveBeenCalledWith(userId, '8012345678', '+234');
  });

  it('passes the authenticated user id to OtpService.verifyOtp', async () => {
    const result = await controller.verifyOtp(userId, {
      phoneNumber: '8012345678',
      otp: '123456',
    } as any);
    expect(mockOtpService.verifyOtp).toHaveBeenCalledWith(userId, '8012345678', '123456');
    expect(result.verified).toBe(true);
  });

  it('passes the authenticated user id to OtpService.getVerificationStatus', async () => {
    await controller.getStatus(userId);
    expect(mockOtpService.getVerificationStatus).toHaveBeenCalledWith(userId);
  });

  it.each(['sendOtp', 'verifyOtp', 'getStatus'] as const)(
    '%s reads the user id from request.user.id (not sub)',
    (method) => {
      const metadata = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        OtpController,
        method,
      ) as Record<string, { data?: string }>;
      const datas = Object.values(metadata).map((m) => m.data);
      expect(datas).toContain('id');
      expect(datas).not.toContain('sub');
    },
  );
});
