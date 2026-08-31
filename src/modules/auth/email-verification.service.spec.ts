import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { EmailVerificationService } from './email-verification.service';

describe('EmailVerificationService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    dataExportJob: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const jwt = {
    sign: jest.fn().mockReturnValue('signed-token'),
    verify: jest.fn(),
  };

  const config = {
    get: jest.fn((key: string, defaultVal?: any) => {
      const map: Record<string, any> = {
        JWT_SECRET: 'test-secret',
        EMAIL_VERIFICATION_EXPIRES_IN: '86400',
        EMAIL_VERIFICATION_BASE_URL: 'http://localhost:3000/verify-email',
        PLATFORM_NAME: 'Hamplard',
        EMAIL_FROM: 'noreply@hamplard.com',
      };
      return map[key] ?? defaultVal;
    }),
  };

  const notifications = {
    transporter: {
      sendMail: jest.fn().mockResolvedValue(true),
    },
  };

  beforeEach(() => jest.clearAllMocks());

  describe('requestVerification', () => {
    it('sends verification email for unverified user with email', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test',
        emailVerifiedAt: null,
      });
      notifications.transporter.sendMail.mockResolvedValue(true);

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.requestVerification('user-1');

      expect(result.message).toBe('Verification email sent');
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          purpose: 'email_verification',
          email: 'test@example.com',
        }),
        expect.objectContaining({ secret: 'test-secret' }),
      );
      expect(notifications.transporter.sendMail).toHaveBeenCalled();
    });

    it('rejects user without email', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: null,
        emailVerifiedAt: null,
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.requestVerification('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects already verified user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerifiedAt: new Date(),
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.requestVerification('user-1');
      expect(result.message).toBe('Email is already verified');
    });

    it('enforces rate limiting on resend', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerifiedAt: null,
      });
      notifications.transporter.sendMail.mockResolvedValue(true);

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await service.requestVerification('user-1');

      await expect(service.requestVerification('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws for non-existent user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.requestVerification('nonexistent')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('confirmVerification', () => {
    it('verifies email with valid token', async () => {
      jwt.verify.mockReturnValue({
        sub: 'user-1',
        purpose: 'email_verification',
        email: 'test@example.com',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerifiedAt: null,
      });
      prisma.user.update.mockResolvedValue({});

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.confirmVerification('valid-token');

      expect(result.verified).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { emailVerifiedAt: expect.any(Date), isVerified: true },
      });
    });

    it('rejects token with wrong purpose', async () => {
      jwt.verify.mockReturnValue({
        sub: 'user-1',
        purpose: 'login',
        email: 'test@example.com',
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.confirmVerification('wrong-purpose-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects expired or invalid token', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.confirmVerification('expired-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('handles already verified user gracefully', async () => {
      jwt.verify.mockReturnValue({
        sub: 'user-1',
        purpose: 'email_verification',
        email: 'test@example.com',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        emailVerifiedAt: new Date(),
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.confirmVerification('valid-token');

      expect(result.verified).toBe(true);
      expect(result.message).toBe('Email is already verified');
    });

    it('rejects when email has changed', async () => {
      jwt.verify.mockReturnValue({
        sub: 'user-1',
        purpose: 'email_verification',
        email: 'old@example.com',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'new@example.com',
        emailVerifiedAt: null,
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.confirmVerification('valid-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects token for non-existent user', async () => {
      jwt.verify.mockReturnValue({
        sub: 'nonexistent',
        purpose: 'email_verification',
        email: 'test@example.com',
      });
      prisma.user.findUnique.mockResolvedValue(null);

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      await expect(service.confirmVerification('valid-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('getVerificationStatus', () => {
    it('returns verification status', async () => {
      const verifiedDate = new Date('2026-01-01');
      prisma.user.findUnique.mockResolvedValue({
        emailVerifiedAt: verifiedDate,
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.getVerificationStatus('user-1');
      expect(result.emailVerified).toBe(true);
      expect(result.emailVerifiedAt).toBe(verifiedDate);
    });

    it('returns unverified status', async () => {
      prisma.user.findUnique.mockResolvedValue({
        emailVerifiedAt: null,
      });

      const service = new EmailVerificationService(
        prisma as any,
        jwt as any,
        config as any,
        notifications as any,
      );

      const result = await service.getVerificationStatus('user-1');
      expect(result.emailVerified).toBe(false);
      expect(result.emailVerifiedAt).toBeNull();
    });
  });
});
