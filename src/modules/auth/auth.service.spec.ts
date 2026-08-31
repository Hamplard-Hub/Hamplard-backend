import { UnauthorizedException } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const jwt = {
    decode: jest.fn().mockReturnValue({
      sub: 'user-1',
      jti: 'access-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  };
  const referrals = {
    validateCode: jest.fn(),
    trackSignup: jest.fn(),
  };
  const sessions = {
    createSession: jest.fn(),
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

  const buildService = () =>
    new AuthService(
      prisma as any,
      jwt as any,
      referrals as any,
      sessions as any,
      refreshTokens as any,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.decode.mockReturnValue({
      sub: 'user-1',
      jti: 'access-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('issues an access/refresh pair on login and tracks the session', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.upsert.mockResolvedValue(user);
    jest.spyOn(StrKey, 'isValidEd25519PublicKey').mockReturnValue(true);
    const service = buildService();
    jest.spyOn(service, 'verifySignature').mockReturnValue(true);
    const nonce = service.generateNonce('GABC');

    const result = await service.login({
      stellarAddress: 'GABC',
      signedNonce: nonce,
      signature: 'sig',
    });

    expect(refreshTokens.issueTokenPair).toHaveBeenCalledWith(user);
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        jti: 'access-jti',
      }),
    );
    expect(result.accessToken).toBe('access-jwt');
    expect(result.refreshToken).toBe('refresh-jwt');
    expect(result.user).toEqual(user);
  });

  it('exchanges a refresh token through the rotation service', async () => {
    const service = buildService();

    const result = await service.refresh('refresh-jwt');

    expect(refreshTokens.rotate).toHaveBeenCalledWith('refresh-jwt');
    expect(sessions.createSession).toHaveBeenCalled();
    expect(result).toEqual({
      accessToken: 'access-jwt-2',
      refreshToken: 'refresh-jwt-2',
    });
  });

  it('rejects login when the nonce has expired', async () => {
    jest.spyOn(StrKey, 'isValidEd25519PublicKey').mockReturnValue(true);
    const service = buildService();

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
