import { UnauthorizedException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
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

  it('succeeds and issues tokens when signature and nonce are valid', async () => {
    const keypair = Keypair.random();
    const stellarAddress = keypair.publicKey();
    const user = {
      id: 'user-1',
      stellarAddress,
      googleId: null,
      role: 'STUDENT',
    };
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.upsert.mockResolvedValue(user);

    const service = buildService();
    const nonce = service.generateNonce(stellarAddress);
    const signature = keypair.sign(Buffer.from(nonce, 'utf-8')).toString('base64');

    const result = await service.login({
      stellarAddress,
      signedNonce: nonce,
      signature,
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

  it('rejects login when signature verification fails', async () => {
    const keypair = Keypair.random();
    const wrongKeypair = Keypair.random();
    const stellarAddress = keypair.publicKey();

    const service = buildService();
    const nonce = service.generateNonce(stellarAddress);
    const wrongSignature = wrongKeypair.sign(Buffer.from(nonce, 'utf-8')).toString('base64');

    await expect(
      service.login({
        stellarAddress,
        signedNonce: nonce,
        signature: wrongSignature,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
  });

  it('rejects login when nonce is tampered', async () => {
    const keypair = Keypair.random();
    const stellarAddress = keypair.publicKey();

    const service = buildService();
    const nonce = service.generateNonce(stellarAddress);
    const tamperedNonce = nonce + '_tampered';
    const signature = keypair.sign(Buffer.from(tamperedNonce, 'utf-8')).toString('base64');

    await expect(
      service.login({
        stellarAddress,
        signedNonce: tamperedNonce,
        signature,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
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
    const keypair = Keypair.random();
    const stellarAddress = keypair.publicKey();
    const service = buildService();

    await expect(
      service.login({
        stellarAddress,
        signedNonce: 'signed',
        signature: 'sig',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
  });
});

