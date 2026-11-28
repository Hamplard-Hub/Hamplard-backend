import { Test, TestingModule } from '@nestjs/testing';
import { ImpersonationService } from './impersonation.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

const mockAdminUser = {
  id: 'admin-1',
  stellarAddress: 'GADMIN123',
  email: 'admin@hamplard.com',
  name: 'Admin User',
  role: 'ADMIN',
};

const mockTargetUser = {
  id: 'user-1',
  stellarAddress: 'GUSER123',
  email: 'student@hamplard.com',
  name: 'Student User',
  role: 'STUDENT',
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-impersonation-jwt-token'),
};

describe('ImpersonationService', () => {
  let service: ImpersonationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
    jest.clearAllMocks();
  });

  describe('startImpersonation()', () => {
    it('starts impersonation session and returns scoped token and audit log', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-1') return Promise.resolve(mockAdminUser);
        if (where.id === 'user-1') return Promise.resolve(mockTargetUser);
        return Promise.resolve(null);
      });

      const result = await service.startImpersonation('admin-1', {
        targetUserId: 'user-1',
        durationSeconds: 1800,
        reason: 'Debugging student payment issue',
      });

      expect(result.accessToken).toBe('mock-impersonation-jwt-token');
      expect(result.durationSeconds).toBe(1800);
      expect(result.targetUser.id).toBe('user-1');

      const audit = service.getAuditTrail();
      expect(audit.total).toBe(1);
      expect(audit.data[0].adminId).toBe('admin-1');
      expect(audit.data[0].targetUserId).toBe('user-1');
      expect(audit.data[0].reason).toBe('Debugging student payment issue');
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorId: 'admin-1',
            targetId: 'user-1',
          }),
        }),
      );
    });

    it('throws ForbiddenException if requesting user is not admin', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockTargetUser,
        role: 'STUDENT',
      });

      await expect(
        service.startImpersonation('user-1', { targetUserId: 'user-2' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if target user does not exist', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-1') return Promise.resolve(mockAdminUser);
        return Promise.resolve(null);
      });

      await expect(
        service.startImpersonation('admin-1', { targetUserId: 'non-existent' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('verifySession() and endSession()', () => {
    it('verifies active session and ends it', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-1') return Promise.resolve(mockAdminUser);
        if (where.id === 'user-1') return Promise.resolve(mockTargetUser);
        return Promise.resolve(null);
      });

      const started = await service.startImpersonation('admin-1', {
        targetUserId: 'user-1',
      });

      const verified = service.verifySession(started.sessionId);
      expect(verified.isActive).toBe(true);

      const ended = service.endSession(started.sessionId, 'admin-1');
      expect(ended.status).toBe('ENDED');

      const reVerified = service.verifySession(started.sessionId);
      expect(reVerified.isActive).toBe(false);
    });
  });
});
