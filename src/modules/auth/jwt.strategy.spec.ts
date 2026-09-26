import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = { get: jest.fn().mockReturnValue('access-secret') };
  const prisma = {
    user: {
      findUnique: jest.fn(),
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
    const strategy = new JwtStrategy(config as any, prisma as any);

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
    const strategy = new JwtStrategy(config as any, prisma as any);

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
    const strategy = new JwtStrategy(config as any, prisma as any);

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
    const strategy = new JwtStrategy(config as any, prisma as any);

    await expect(
      strategy.validate({
        sub: 'user-1',
        role: 'STUDENT',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws UnauthorizedException when user no longer exists in DB', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const strategy = new JwtStrategy(config as any, prisma as any);

    await expect(
      strategy.validate({
        sub: 'user-999',
        role: 'STUDENT',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a refresh token presented as an access token', async () => {
    const strategy = new JwtStrategy(config as any, prisma as any);

    await expect(
      strategy.validate({
        sub: 'user-1',
        familyId: 'family-1',
        generation: 1,
        typ: 'refresh',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

