import { Test, TestingModule } from '@nestjs/testing';
import { ImpersonationService } from './impersonation.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ImpersonationSessionStatus } from '@prisma/client';

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
  impersonationSession: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  adminAuditLog: {
    create: jest.fn(),
  },
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-impersonation-jwt-token'),
};

const mockConfigService = {
  get: jest.fn().mockReturnValue('secret'),
};

describe('ImpersonationService', () => {
  let service: ImpersonationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
    jest.clearAllMocks();
  });

  describe('startImpersonation()', () => {
    it('creates impersonation session in database and returns scoped token', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-1') return Promise.resolve(mockAdminUser);
        if (where.id === 'user-1') return Promise.resolve(mockTargetUser);
        return Promise.resolve(null);
      });

      mockPrisma.impersonationSession.create.mockResolvedValue({
        id: 'session-1',
        sessionId: expect.any(String),
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: ImpersonationSessionStatus.ACTIVE,
      });

      const result = await service.startImpersonation('admin-1', {
        targetUserId: 'user-1',
        durationSeconds: 1800,
        reason: 'Debugging student payment issue',
      });

      expect(result.accessToken).toBe('mock-impersonation-jwt-token');
      expect(result.durationSeconds).toBe(1800);
      expect(result.targetUser.id).toBe('user-1');
      expect(mockPrisma.impersonationSession.create).toHaveBeenCalled();
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'admin-1',
          action: 'IMPERSONATION_STARTED',
          targetType: 'USER',
          targetId: 'user-1',
        }),
      });
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

  describe('getActiveSessions()', () => {
    it('returns only active, non-expired sessions', async () => {
      const now = new Date();
      mockPrisma.impersonationSession.findMany.mockResolvedValue([
        { sessionId: 'session-1', status: 'ACTIVE', expiresAt: new Date(now.getTime() + 3600000) },
      ]);

      const result = await service.getActiveSessions();

      expect(result).toHaveLength(1);
      expect(mockPrisma.impersonationSession.findMany).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { startedAt: 'desc' },
      });
    });
  });

  describe('endSession()', () => {
    it('ends session by originating admin', async () => {
      mockPrisma.impersonationSession.findUnique.mockResolvedValue({
        sessionId: 'session-1',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
      });

      const result = await service.endSession('session-1', 'admin-1', false);

      expect(result.status).toBe('ENDED');
      expect(mockPrisma.impersonationSession.update).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        data: {
          status: 'ENDED',
          endedAt: expect.any(Date),
          endedBy: 'admin-1',
          forceEndedBy: null,
        },
      });
    });

    it('allows force-end by different admin', async () => {
      mockPrisma.impersonationSession.findUnique.mockResolvedValue({
        sessionId: 'session-1',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
      });

      const result = await service.endSession('session-1', 'admin-2', true);

      expect(result.status).toBe('FORCE_ENDED');
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: 'admin-2',
          action: 'IMPERSONATION_ENDED',
          metadata: expect.objectContaining({
            forceEnded: true,
            originalAdminId: 'admin-1',
          }),
        }),
      });
    });

    it('throws ForbiddenException when non-originating admin tries to end without force flag', async () => {
      mockPrisma.impersonationSession.findUnique.mockResolvedValue({
        sessionId: 'session-1',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
      });

      await expect(
        service.endSession('session-1', 'admin-2', false),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('verifySession()', () => {
    it('returns session status and marks expired sessions', async () => {
      const now = new Date();
      const expiredDate = new Date(now.getTime() - 1000);
      mockPrisma.impersonationSession.findUnique.mockResolvedValue({
        sessionId: 'session-1',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
        startedAt: now,
        expiresAt: expiredDate,
      });

      const result = await service.verifySession('session-1');

      expect(result.isActive).toBe(false);
      expect(result.status).toBe('EXPIRED');
      expect(mockPrisma.impersonationSession.update).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        data: { status: 'EXPIRED' },
      });
    });
  });

  describe('persistence across service instantiations', () => {
    it('session data survives service restart', async () => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-1') return Promise.resolve(mockAdminUser);
        if (where.id === 'user-1') return Promise.resolve(mockTargetUser);
        return Promise.resolve(null);
      });

      mockPrisma.impersonationSession.create.mockResolvedValue({
        sessionId: 'persistent-session',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });

      await service.startImpersonation('admin-1', { targetUserId: 'user-1' });

      mockPrisma.impersonationSession.findUnique.mockResolvedValue({
        sessionId: 'persistent-session',
        adminId: 'admin-1',
        targetUserId: 'user-1',
        status: 'ACTIVE',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });

      const session = await service.verifySession('persistent-session');
      expect(session.sessionId).toBe('persistent-session');
    });
  });
});