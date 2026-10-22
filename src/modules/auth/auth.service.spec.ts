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

  const twoFactor = {
    verifyLoginCode: jest.fn(),
  };

  const config = { get: jest.fn(() => null) };
  const cacheMap = new Map<string, any>();
  const cache = {
    get: jest.fn(async (key: string) => cacheMap.get(key)),
    set: jest.fn(async (key: string, val: any) => cacheMap.set(key, val)),
    del: jest.fn(async (key: string) => cacheMap.delete(key)),
  };

  const buildService = () =>
    new AuthService(
      prisma as any,
      jwt as any,
      config as any,
      referrals as any,
      sessions as any,
      refreshTokens as any,
      twoFactor as any,
      cache as any,
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
    const nonce = await service.generateNonce(stellarAddress);
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
    const nonce = await service.generateNonce(stellarAddress);
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
    const nonce = await service.generateNonce(stellarAddress);
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
  describe('two-factor authentication on login', () => {
    const signedLoginPayload = async (service: AuthService, keypair: Keypair) => {
      const stellarAddress = keypair.publicKey();
      const nonce = await service.generateNonce(stellarAddress);
      const signature = keypair.sign(Buffer.from(nonce, 'utf-8')).toString('base64');
      return { stellarAddress, signedNonce: nonce, signature };
    };

    const twoFactorUser = (stellarAddress: string) => ({
      id: 'user-2fa',
      stellarAddress,
      googleId: null,
      role: 'INSTRUCTOR',
      twoFactorEnabled: true,
    });

    it('returns 401 when 2FA is enabled and no totpCode is supplied', async () => {
      const keypair = Keypair.random();
      const service = buildService();
      const payload = await signedLoginPayload(service, keypair);
      prisma.user.findUnique.mockResolvedValue(twoFactorUser(payload.stellarAddress));

      await expect(service.login(payload)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(twoFactor.verifyLoginCode).not.toHaveBeenCalled();
      expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
    });

    it('returns 401 when the supplied totpCode is invalid', async () => {
      const keypair = Keypair.random();
      const service = buildService();
      const payload = await signedLoginPayload(service, keypair);
      prisma.user.findUnique.mockResolvedValue(twoFactorUser(payload.stellarAddress));
      twoFactor.verifyLoginCode.mockResolvedValue(false);

      await expect(service.login({ ...payload, totpCode: '000000' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(refreshTokens.issueTokenPair).not.toHaveBeenCalled();
    });

    it('issues tokens when the supplied totpCode is valid', async () => {
      const keypair = Keypair.random();
      const service = buildService();
      const payload = await signedLoginPayload(service, keypair);
      const user = twoFactorUser(payload.stellarAddress);
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.user.upsert.mockResolvedValue(user);
      twoFactor.verifyLoginCode.mockResolvedValue(true);

      const result = await service.login({ ...payload, totpCode: '123456' });

      expect(twoFactor.verifyLoginCode).toHaveBeenCalledWith('user-2fa', '123456');
      expect(result.accessToken).toBe('access-jwt');
    });

    it('never returns the TOTP secret or recovery-code hashes in the login payload (issue #234)', async () => {
      const keypair = Keypair.random();
      const service = buildService();
      const payload = await signedLoginPayload(service, keypair);
      const user = {
        ...twoFactorUser(payload.stellarAddress),
        twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        twoFactorRecoveryCodes: ['$2b$10$hash1', '$2b$10$hash2'],
      };
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.user.upsert.mockResolvedValue(user);
      twoFactor.verifyLoginCode.mockResolvedValue(true);

      const result = await service.login({ ...payload, totpCode: '123456' });

      expect(result.user).not.toHaveProperty('twoFactorSecret');
      expect(result.user).not.toHaveProperty('twoFactorRecoveryCodes');
      expect(result.user).toMatchObject({ id: 'user-2fa', twoFactorEnabled: true });
      expect(JSON.stringify(result)).not.toContain('JBSWY3DPEHPK3PXP');
    });
  });
});
