import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { AuthUserCacheService } from '../../common/auth-user/auth-user-cache.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = { get: jest.fn().mockReturnValue('access-secret') };
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    session: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps an access-token payload onto the request user with live DB status', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: 'google-123',
      role: 'STUDENT',
      isBanned: false,
      isSuspended: false,
      suspendedUntil: null,
    });
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    await expect(
      strategy.validate({
        sub: 'user-1',
        stellarAddress: 'GABC',
        googleId: 'google-123',
        role: 'STUDENT',
        jti: 'access-jti',
      }),
    ).resolves.toEqual({
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: 'google-123',
      role: 'STUDENT',
      isBanned: false,
      isSuspended: false,
      isDeactivated: false,
      jti: 'access-jti',
    });
  });

  it('reflects updated live role when user role changes', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: 'google-123',
      role: 'INSTRUCTOR',
      isBanned: false,
      isSuspended: false,
      suspendedUntil: null,
    });
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    const result = await strategy.validate({
      sub: 'user-1',
      role: 'STUDENT',
    });

    expect(result.role).toBe('INSTRUCTOR');
  });

  it('rejects a banned user with ForbiddenException', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: null,
      role: 'STUDENT',
      isBanned: true,
      isSuspended: false,
      suspendedUntil: null,
    });
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    await expect(
      strategy.validate({
        sub: 'user-1',
        role: 'STUDENT',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a currently suspended user with ForbiddenException', async () => {
    const futureDate = new Date(Date.now() + 86400000);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: null,
      role: 'STUDENT',
      isBanned: false,
      isSuspended: true,
      suspendedUntil: futureDate,
    });
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    await expect(
      strategy.validate({
        sub: 'user-1',
        role: 'STUDENT',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws UnauthorizedException when user no longer exists in DB', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    await expect(
      strategy.validate({
        sub: 'user-999',
        role: 'STUDENT',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a refresh token presented as an access token', async () => {
    const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

    await expect(
      strategy.validate({
        sub: 'user-1',
        familyId: 'family-1',
        generation: 1,
        typ: 'refresh',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  describe('account lifecycle (issues #74/#75)', () => {
    const base = {
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: null,
      role: 'STUDENT',
      isBanned: false,
      isSuspended: false,
      suspendedUntil: null,
      deactivatedAt: null,
      deletedAt: null,
    };

    it('rejects a valid token for a deleted account', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...base, deletedAt: new Date() });
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(strategy.validate({ sub: 'user-1', role: 'STUDENT' })).rejects.toThrow(
        'Account has been deleted',
      );
    });

    it('flags a deactivated account so the guard can restrict it', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...base, deactivatedAt: new Date() });
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(strategy.validate({ sub: 'user-1', role: 'STUDENT' })).resolves.toMatchObject({
        id: 'user-1',
        isDeactivated: true,
      });
    });
  });

  describe('session revocation/expiry (issue #418)', () => {
    const base = {
      id: 'user-1',
      stellarAddress: 'GABC',
      googleId: null,
      role: 'STUDENT',
      isBanned: false,
      isSuspended: false,
      suspendedUntil: null,
      deactivatedAt: null,
      deletedAt: null,
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ ...base });
    });

    it('rejects a revoked session token', async () => {
      const future = new Date(Date.now() + 86400000);
      prisma.session.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: future });
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(
        strategy.validate({ sub: 'user-1', role: 'STUDENT', jti: 'access-jti' }),
      ).rejects.toThrow('Session has been revoked');
      expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it('rejects an expired session token', async () => {
      const past = new Date(Date.now() - 1000);
      prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: past });
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(
        strategy.validate({ sub: 'user-1', role: 'STUDENT', jti: 'access-jti' }),
      ).rejects.toThrow('Session has expired');
      expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it('resolves and touches lastActiveAt for an active session', async () => {
      const future = new Date(Date.now() + 86400000);
      prisma.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: future });
      prisma.session.update.mockResolvedValue({});
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      const result = await strategy.validate({ sub: 'user-1', role: 'STUDENT', jti: 'access-jti' });

      expect(result).toMatchObject({ id: 'user-1', jti: 'access-jti' });
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { jti: 'access-jti' },
          data: expect.objectContaining({ lastActiveAt: expect.any(Date) }),
        }),
      );
    });

    it('lets through a token whose jti has no session row', async () => {
      prisma.session.findUnique.mockResolvedValue(null);
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(
        strategy.validate({ sub: 'user-1', role: 'STUDENT', jti: 'orphan-jti' }),
      ).resolves.toMatchObject({ id: 'user-1', jti: 'orphan-jti' });
      expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it('lets through legacy tokens that carry no jti', async () => {
      const strategy = new JwtStrategy(config as any, new AuthUserCacheService(prisma as any));

      await expect(
        strategy.validate({ sub: 'user-1', role: 'STUDENT' }),
      ).resolves.toMatchObject({ id: 'user-1', jti: undefined });
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
    });
  });
});

