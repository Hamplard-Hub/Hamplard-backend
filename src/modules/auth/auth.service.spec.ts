import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const referrals = {
    validateCode: jest.fn(),
    trackSignup: jest.fn(),
  };
  const refreshTokens = {
    issueTokenPair: jest.fn().mockResolvedValue({
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
    }),
    rotate: jest.fn().mockResolvedValue({
      accessToken: 'access-jwt-2',
      refreshToken: 'refresh-jwt-2',
    }),
  };

  const user = {
    id: 'user-1',
    stellarAddress: 'GABC',
    googleId: null,
    role: 'STUDENT',
  };

  beforeEach(() => jest.clearAllMocks());

  it('issues an access/refresh pair on login', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.upsert.mockResolvedValue(user);
    const service = new AuthService(prisma as any, referrals as any, refreshTokens as any);
    service.generateNonce('GABC');

    const result = await service.login({
      stellarAddress: 'GABC',
      signedNonce: 'signed',
      signature: 'sig',
    });

    expect(refreshTokens.issueTokenPair).toHaveBeenCalledWith(user);
    expect(result.accessToken).toBe('access-jwt');
    expect(result.refreshToken).toBe('refresh-jwt');
    expect(result.user).toEqual(user);
  });

  it('exchanges a refresh token through the rotation service', async () => {
    const service = new AuthService(prisma as any, referrals as any, refreshTokens as any);

    const result = await service.refresh('refresh-jwt');

    expect(refreshTokens.rotate).toHaveBeenCalledWith('refresh-jwt');
    expect(result).toEqual({
      accessToken: 'access-jwt-2',
      refreshToken: 'refresh-jwt-2',
    });
  });

  it('rejects login when the nonce has expired', async () => {
    const service = new AuthService(prisma as any, referrals as any, refreshTokens as any);

    await expect(
      service.login({
        stellarAddress: 'GABC',
        signedNonce: 'signed',
        signature: 'sig',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
  });
});
