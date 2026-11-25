import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwoFactorService } from './two-factor.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisRateLimitService } from '../../common/redis-rate-limit/redis-rate-limit.service';
import * as speakeasy from 'speakeasy';

jest.mock('speakeasy');

describe('TwoFactorService — Recovery Codes Regeneration (issue #355)', () => {
  let service: TwoFactorService;
  let prisma: PrismaService;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    twoFactorEnabled: true,
    twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    twoFactorRecoveryCodes: [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // old code 1
      '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae', // old code 2
    ],
  };

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => defaultValue),
  };

  const mockRateLimitService = {
    fixedWindow: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RedisRateLimitService, useValue: mockRateLimitService },
      ],
    }).compile();

    service = module.get<TwoFactorService>(TwoFactorService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  describe('regenerateRecoveryCodes', () => {
    it('should regenerate recovery codes when valid TOTP code is provided', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.user.update.mockResolvedValue({
        ...mockUser,
        twoFactorRecoveryCodes: ['new-hash-1', 'new-hash-2'],
      });

      // Mock speakeasy to return true for TOTP verification
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const result = await service.regenerateRecoveryCodes('user-123', '123456');

      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      });

      expect(speakeasy.totp.verify).toHaveBeenCalledWith({
        secret: mockUser.twoFactorSecret,
        encoding: 'base32',
        token: '123456',
        window: 1,
      });

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: {
          twoFactorRecoveryCodes: expect.arrayContaining([
            expect.any(String),
          ]),
        },
      });

      expect(result.recoveryCodes).toBeDefined();
      expect(result.recoveryCodes).toHaveLength(10);
      expect(result.recoveryCodes[0]).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.regenerateRecoveryCodes('invalid-user', '123456')).rejects.toThrow(
        NotFoundException,
      );

      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when 2FA is not enabled', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockUser,
        twoFactorEnabled: false,
        twoFactorSecret: null,
      });

      await expect(service.regenerateRecoveryCodes('user-123', '123456')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.regenerateRecoveryCodes('user-123', '123456')).rejects.toThrow(
        'Two-factor authentication is not enabled for this account',
      );

      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when TOTP code is invalid', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(false);

      await expect(service.regenerateRecoveryCodes('user-123', '000000')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.regenerateRecoveryCodes('user-123', '000000')).rejects.toThrow(
        'Invalid two-factor authentication code',
      );

      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('should not accept recovery codes for regeneration', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      
      // Recovery codes should not work (only TOTP)
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(false);

      await expect(
        service.regenerateRecoveryCodes('user-123', 'A1B2C-D3E4F'),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.user.update).not.toHaveBeenCalled();
    });

    it('should generate exactly 10 new recovery codes', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.user.update.mockResolvedValue(mockUser);
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const result = await service.regenerateRecoveryCodes('user-123', '123456');

      expect(result.recoveryCodes).toHaveLength(10);

      // Check all codes match the expected format
      result.recoveryCodes.forEach((code) => {
        expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
      });
    });

    it('should replace old recovery codes with new ones', async () => {
      const oldCodes = [
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
      ];

      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockUser,
        twoFactorRecoveryCodes: oldCodes,
      });

      let capturedNewCodes: string[] = [];
      mockPrismaService.user.update.mockImplementation(async ({ data }: any) => {
        capturedNewCodes = data.twoFactorRecoveryCodes;
        return { ...mockUser, twoFactorRecoveryCodes: capturedNewCodes };
      });

      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      await service.regenerateRecoveryCodes('user-123', '123456');

      // Verify that the update was called with new codes
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: {
          twoFactorRecoveryCodes: expect.any(Array),
        },
      });

      // Verify new codes are different from old codes
      expect(capturedNewCodes).toHaveLength(10);
      expect(capturedNewCodes).not.toContain(oldCodes[0]);
      expect(capturedNewCodes).not.toContain(oldCodes[1]);
    });

    it('should hash recovery codes before storing', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      
      let storedCodes: string[] = [];
      mockPrismaService.user.update.mockImplementation(async ({ data }: any) => {
        storedCodes = data.twoFactorRecoveryCodes;
        return mockUser;
      });

      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const result = await service.regenerateRecoveryCodes('user-123', '123456');

      // Plain codes should be in result
      expect(result.recoveryCodes).toHaveLength(10);
      result.recoveryCodes.forEach((code) => {
        expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
      });

      // Stored codes should be hashes (SHA-256 hex strings)
      expect(storedCodes).toHaveLength(10);
      storedCodes.forEach((hash) => {
        expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64-char hex string
        // Hash should not match any plain code
        expect(result.recoveryCodes).not.toContain(hash);
      });
    });

    it('should log successful regeneration', async () => {
      const loggerSpy = jest.spyOn(service['logger'], 'log');
      
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.user.update.mockResolvedValue(mockUser);
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      await service.regenerateRecoveryCodes('user-123', '123456');

      expect(loggerSpy).toHaveBeenCalledWith('Recovery codes regenerated for user user-123');
    });
  });

  describe('Old recovery codes should not work after regeneration', () => {
    it('should not accept old recovery codes after regeneration', async () => {
      // Initial state with old codes
      const oldPlainCodes = ['A1B2C-D3E4F', 'G5H6I-J7K8L'];
      const oldHashedCodes = oldPlainCodes.map((code) => {
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
      });

      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockUser,
        twoFactorRecoveryCodes: oldHashedCodes,
      });

      // Regenerate codes
      let newHashedCodes: string[] = [];
      mockPrismaService.user.update.mockImplementation(async ({ data }: any) => {
        newHashedCodes = data.twoFactorRecoveryCodes;
        return { ...mockUser, twoFactorRecoveryCodes: newHashedCodes };
      });

      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const result = await service.regenerateRecoveryCodes('user-123', '123456');

      // After regeneration, old codes should not be in the new set
      oldHashedCodes.forEach((oldHash) => {
        expect(newHashedCodes).not.toContain(oldHash);
      });

      // Verify plain codes don't match old codes
      oldPlainCodes.forEach((oldCode) => {
        expect(result.recoveryCodes).not.toContain(oldCode);
      });
    });
  });
});
