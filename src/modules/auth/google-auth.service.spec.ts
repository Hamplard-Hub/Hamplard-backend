import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GoogleAuthService, GoogleIdentity } from './google-auth.service';

describe('GoogleAuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const jwt = {
    decode: jest.fn().mockReturnValue({
      sub: 'user-1',
      jti: 'access-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  };
  const sessions = {
    createSession: jest.fn(),
  };
  const refreshTokens = {
    issueTokenPair: jest.fn().mockResolvedValue({
      accessToken: 'platform-jwt',
      refreshToken: 'refresh-jwt',
    }),
  };
  const config = { get: jest.fn((key: string) => key === 'GOOGLE_CLIENT_ID' ? 'google-client-id' : 'google-client-secret') };
  const cacheMap = new Map<string, any>();
  const cache = {
    get: jest.fn(async (key: string) => cacheMap.get(key)),
    set: jest.fn(async (key: string, val: any) => cacheMap.set(key, val)),
    del: jest.fn(async (key: string) => cacheMap.delete(key)),
  };
  const twoFactor = {
    isEnabled: jest.fn().mockResolvedValue(false),
    verifyLoginTotp: jest.fn().mockResolvedValue(true),
  };

  const buildService = () =>
    new GoogleAuthService(
      prisma as any,
      jwt as any,
      sessions as any,
      refreshTokens as any,
      cache as any,
      twoFactor as any,
      config as any,
    );

  const identity: GoogleIdentity = {
    googleId: 'google-123',
    email: 'person@example.com',
    emailVerified: true,
    name: 'Person Example',
    avatarUrl: 'https://example.com/avatar.jpg',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'google-client-id' : 'google-client-secret',
    );
    jwt.decode.mockReturnValue({
      sub: 'user-1',
      jti: 'access-jti',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('creates and consumes single-use OAuth state values', async () => {
    const service = buildService();
    const state = await service.createOAuthState();

    expect(await service.consumeOAuthState(state)).toBe(true);
    expect(await service.consumeOAuthState(state)).toBe(false);
  });

  it('rejects an ID token when Google signature verification fails', async () => {
    const service = buildService();
    (service as any).googleClient.verifyIdToken = jest.fn().mockRejectedValue(new Error('bad token'));

    await expect(service.verifyIdToken('invalid-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('creates a walletless user and returns a platform JWT pair', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      stellarAddress: null,
      googleId: identity.googleId,
      role: 'STUDENT',
      ...identity,
    });
    const service = buildService();

    const result = await service.login(identity);

    expect(prisma.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      googleId: identity.googleId,
      email: identity.email,
      role: 'STUDENT',
    }) });
    expect(refreshTokens.issueTokenPair).toHaveBeenCalledWith(expect.objectContaining({
      id: 'user-1',
      googleId: identity.googleId,
      stellarAddress: null,
    }));
    expect(result.accessToken).toBe('platform-jwt');
    expect(result.refreshToken).toBe('refresh-jwt');
  });

  it('does not allow a client to choose the instructor role', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      stellarAddress: null,
      googleId: identity.googleId,
      role: 'STUDENT',
    });
    const service = buildService();

    await service.login(identity);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'STUDENT' }),
    });
  });

  it('links a verified Google account to an existing email user', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-user',
        email: identity.email,
        googleId: null,
        name: 'Existing Name',
        avatarUrl: null,
        isVerified: true,
      });
    prisma.user.update.mockResolvedValue({
      id: 'existing-user',
      stellarAddress: 'GABC',
      googleId: identity.googleId,
      role: 'STUDENT',
    });
    const service = buildService();

    await service.login(identity);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'existing-user' },
      data: expect.objectContaining({ googleId: identity.googleId }),
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('never returns the TOTP secret or recovery-code hashes in the login payload (issue #234)', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-2fa',
      email: identity.email,
      googleId: identity.googleId,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    prisma.user.update.mockResolvedValue({
      id: 'user-2fa',
      stellarAddress: null,
      googleId: identity.googleId,
      email: identity.email,
      role: 'STUDENT',
      twoFactorEnabled: true,
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      twoFactorRecoveryCodes: ['$2b$10$hash1'],
    });
    const service = buildService();

    const result = await service.login(identity);

    expect(result.user).not.toHaveProperty('twoFactorSecret');
    expect(result.user).not.toHaveProperty('twoFactorRecoveryCodes');
    expect(result.user).toMatchObject({ id: 'user-2fa', twoFactorEnabled: true });
    expect(JSON.stringify(result)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  describe('when Google credentials are configured', () => {
    it('is enabled and does not throw from assertEnabled', () => {
      const service = buildService();

      expect(service.enabled).toBe(true);
      expect(() => service.assertEnabled()).not.toThrow();
    });
  });

  describe('when Google credentials are missing', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) =>
        key === 'GOOGLE_CLIENT_ID' ? 'google-client-id' : undefined,
      );
    });

    it('constructs without throwing and is disabled', () => {
      const service = buildService();

      expect(service.enabled).toBe(false);
    });

    it('is disabled when only the secret is set', () => {
      config.get.mockImplementation((key: string) =>
        key === 'GOOGLE_CLIENT_SECRET' ? 'google-client-secret' : undefined,
      );

      expect(buildService().enabled).toBe(false);
    });

    it('rejects ID token login with 503 "not configured"', async () => {
      const service = buildService();

      await expect(service.loginWithIdToken('any-token')).rejects.toThrow(
        new ServiceUnavailableException('Google authentication is not configured'),
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });
});
