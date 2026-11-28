import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  let service: SessionsService;

  const mockPrisma = {
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: {
      updateMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(SessionsService);
  });

  describe('createSession()', () => {
    it('creates a session with familyId and device metadata', async () => {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      mockPrisma.session.create.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        jti: 'jti-1',
        familyId: 'family-1',
        expiresAt,
      });

      const result = await service.createSession({
        userId: 'user-1',
        jti: 'jti-1',
        expiresAt,
        familyId: 'family-1',
        meta: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ipAddress: '127.0.0.1' },
      });

      expect(mockPrisma.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          jti: 'jti-1',
          familyId: 'family-1',
          expiresAt,
          ipAddress: '127.0.0.1',
        }),
      });
      expect(result.id).toBe('session-1');
    });
  });

  describe('revokeSession()', () => {
    it('revokes a session and its linked refresh token family (issue #416)', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        familyId: 'family-1',
        revokedAt: null,
      });
      mockPrisma.session.update.mockResolvedValue({
        id: 'session-1',
        revokedAt: new Date(),
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.revokeSession('user-1', 'session-1');

      expect(result.revoked).toBe(true);
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { revokedAt: expect.any(Date) },
      });
      // Crucial: Acceptance Criteria - revoking a session revokes the linked family
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('throws NotFoundException if session does not exist', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      await expect(service.revokeSession('user-1', 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if user does not own the session', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'other-user',
        familyId: 'family-1',
        revokedAt: null,
      });

      await expect(service.revokeSession('user-1', 'session-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('returns immediately if session is already revoked', async () => {
      const revokedAt = new Date();
      mockPrisma.session.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        familyId: 'family-1',
        revokedAt,
      });

      const result = await service.revokeSession('user-1', 'session-1');

      expect(result).toEqual({ id: 'session-1', revoked: true, revokedAt });
      expect(mockPrisma.session.update).not.toHaveBeenCalled();
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  it('lists sessions as non-current when no active JTI is supplied', async () => {
    mockPrisma.session.findMany.mockResolvedValue([
      {
        id: 'session-1',
        jti: 'session-jti',
        deviceLabel: 'Chrome on Windows',
        userAgent: 'browser',
        ipAddress: '127.0.0.1',
        createdAt: new Date(),
        lastActiveAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(service.listSessions('user-1')).resolves.toEqual([
      expect.objectContaining({ id: 'session-1', isCurrent: false }),
    ]);
  });

  describe('revokeAllExceptCurrent()', () => {
    it('revokes other sessions and their linked refresh token families, preserving current family', async () => {
      mockPrisma.session.findMany.mockResolvedValue([
        { id: 'session-2', familyId: 'family-2' },
        { id: 'session-3', familyId: 'family-3' },
      ]);
      mockPrisma.session.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.session.findUnique.mockResolvedValue({
        familyId: 'family-current',
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 4 });

      const result = await service.revokeAllExceptCurrent('user-1', 'jti-current');

      expect(result.revoked).toBe(true);
      expect(result.revokedCount).toBe(2);
      expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null, jti: { not: 'jti-current' } },
        select: { id: true, familyId: true },
      });
      expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null, jti: { not: 'jti-current' } },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: { in: ['family-2', 'family-3'] }, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
