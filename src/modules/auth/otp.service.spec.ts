import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TooManyRequestsException, UnauthorizedException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('OtpService', () => {
  let service: OtpService;
  let prisma: PrismaService;

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
        NODE_ENV: 'test',
        AFRICASTALKING_USERNAME: 'test_username',
        AFRICASTALKING_API_KEY: 'test_api_key',
        AFRICASTALKING_SENDER_ID: 'TestSender',
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
        data: {
          isUsed: true,
        },
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
    });

    it('should enforce rate limiting', async () => {
      mockPrismaService.phoneOtp.updateMany.mockResolvedValue({ count: 0 });
      mockPrismaService.phoneOtp.create.mockResolvedValue({} as any);

      // First 3 requests should succeed
      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');
      await service.sendOtp('user-123', '+254712345678', 'KE');

      // Fourth request should be rate limited
      await expect(
        service.sendOtp('user-123', '+254712345678', 'KE'),
      ).rejects.toThrow(TooManyRequestsException);
    });
  });

  describe('verifyOtp', () => {
    const mockOtpRecord = {
      id: 'otp-123',
      userId: 'user-123',
      phoneNumber: '+254712345678',
      countryCode: 'KE',
      otp: '123456',
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
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
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
        data: {
          attemptCount: 1,
        },
      });
    });

    it('should reject OTP after max attempts', async () => {
      const maxAttemptsOtp = {
        ...mockOtpRecord,
        attemptCount: 5,
      };
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
