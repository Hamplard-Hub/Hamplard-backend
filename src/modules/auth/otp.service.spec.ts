import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpService, TooManyRequestsException } from './otp.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisRateLimitService } from '../../common/redis-rate-limit/redis-rate-limit.service';

// Stub the Africa's Talking SDK so sendOtp never makes a real HTTP request.
const mockSmsSend = jest.fn().mockResolvedValue({ SMSMessageData: { Recipients: [] } });
jest.mock('africastalking', () => jest.fn(() => ({ SMS: { send: mockSmsSend } })));

// ---------------------------------------------------------------------------
// In-memory Redis mock — increments a counter per key
// ---------------------------------------------------------------------------

class FakeRedisRateLimitService {
  private counters = new Map<string, number>();

  async fixedWindow(key: string, windowSeconds: number) {
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return { count, ttlSeconds: windowSeconds };
  }

  reset() { this.counters.clear(); }
}

describe('OtpService', () => {
  let service: OtpService;
  let fakeRl: FakeRedisRateLimitService;

  const mockPrismaService = {
    phoneOtp: {
      updateMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        NODE_ENV:                    'test',
        AFRICASTALKING_USERNAME:     'test_username',
        AFRICASTALKING_API_KEY:      'test_api_key',
        AFRICASTALKING_SENDER_ID:    'TestSender',
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    fakeRl = new FakeRedisRateLimitService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService,          useValue: mockPrismaService },
        { provide: ConfigService,          useValue: mockConfigService },
        { provide: RedisRateLimitService,  useValue: fakeRl },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    fakeRl.reset();
  });

  describe('sendOtp', () => {
    it('should invalidate existing OTPs and create a new one', async () => {
      mockPrismaService.phoneOtp.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.phoneOtp.create.mockResolvedValue({
        id: 'otp-123',
        userId: 'user-123',
        phoneNumber: '+254712345678',
        countryCode: 'KE',
        otp: '123456',
        attemptCount: 0,
        expiresAt: new Date(),
        isUsed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.sendOtp('user-123', '+254712345678', 'KE');

      expect(mockPrismaService.phoneOtp.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          phoneNumber: '+254712345678',
          isUsed: false,
        },
        data: { isUsed: true },
      });

      expect(mockPrismaService.phoneOtp.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          phoneNumber: '+254712345678',
          countryCode: 'KE',
          otp: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      });

      expect(mockSmsSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['+254712345678'], from: 'TestSender' }),
      );
    });

    it('should enforce rate limiting via Redis fixed-window counter', async () => {
      mockPrismaService.phoneOtp.updateMany.mockResolvedValue({ count: 0 });
      mockPrismaService.phoneOtp.create.mockResolvedValue({} as any);

      // First 3 requests should succeed (counter stays <= OTP_RATE_LIMIT_MAX_REQUESTS = 3).
      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');

      // Fourth request: counter becomes 4 > 3, should be rate-limited.
      await expect(
        service.sendOtp('user-123', '+254712345678', 'KE'),
      ).rejects.toThrow(TooManyRequestsException);
    });

    it('should use a separate counter for a different phone number', async () => {
      mockPrismaService.phoneOtp.updateMany.mockResolvedValue({ count: 0 });
      mockPrismaService.phoneOtp.create.mockResolvedValue({} as any);

      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');

      // A different phone number starts with counter = 0.
      await expect(
        service.sendOtp('user-456', '+254799999999', 'KE'),
      ).resolves.toBeUndefined();
    });
  });

  describe('verifyOtp', () => {
    const mockOtpRecord = {
      id: 'otp-123',
      userId: 'user-123',
      phoneNumber: '+254712345678',
      countryCode: 'KE',
      get otp() {
        return (service as any).hashOtp('123456');
      },
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
      verifiedAt: null,
      isUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should verify valid OTP and update user', async () => {
      mockPrismaService.phoneOtp.findFirst.mockResolvedValue(mockOtpRecord);
      mockPrismaService.phoneOtp.update.mockResolvedValue({} as any);
      mockPrismaService.user.update.mockResolvedValue({} as any);

      const result = await service.verifyOtp('user-123', '+254712345678', '123456');

      expect(result).toBe(true);
      expect(mockPrismaService.phoneOtp.update).toHaveBeenCalledWith({
        where: { id: 'otp-123' },
        data: {
          isUsed: true,
          verifiedAt: expect.any(Date),
        },
      });
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: {
          phoneNumber: '+254712345678',
          phoneCountryCode: 'KE',
          isPhoneVerified: true,
          phoneVerifiedAt: expect.any(Date),
        },
      });
    });

    it('should reject expired OTP', async () => {
      const expiredOtp = {
        ...mockOtpRecord,
        expiresAt: new Date(Date.now() - 1000),
      };
      mockPrismaService.phoneOtp.findFirst.mockResolvedValue(expiredOtp);
      mockPrismaService.phoneOtp.update.mockResolvedValue({} as any);

      await expect(
        service.verifyOtp('user-123', '+254712345678', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject invalid OTP and increment attempt count', async () => {
      mockPrismaService.phoneOtp.findFirst.mockResolvedValue(mockOtpRecord);
      mockPrismaService.phoneOtp.update.mockResolvedValue({} as any);

      await expect(
        service.verifyOtp('user-123', '+254712345678', '999999'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.phoneOtp.update).toHaveBeenCalledWith({
        where: { id: 'otp-123' },
        data: { attemptCount: 1 },
      });
    });

    it('should reject OTP after max attempts', async () => {
      const maxAttemptsOtp = { ...mockOtpRecord, attemptCount: 5 };
      mockPrismaService.phoneOtp.findFirst.mockResolvedValue(maxAttemptsOtp);
      mockPrismaService.phoneOtp.update.mockResolvedValue({} as any);

      await expect(
        service.verifyOtp('user-123', '+254712345678', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getVerificationStatus', () => {
    it('should return user phone verification status', async () => {
      const mockUser = {
        isPhoneVerified: true,
        phoneNumber: '+254712345678',
        phoneVerifiedAt: new Date(),
      };
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.getVerificationStatus('user-123');

      expect(result).toEqual({
        isPhoneVerified: true,
        phoneNumber: '+254712345678',
        phoneVerifiedAt: expect.any(Date),
      });
    });
  });
});
