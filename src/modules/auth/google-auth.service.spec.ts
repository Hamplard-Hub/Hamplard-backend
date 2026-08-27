import { UnauthorizedException } from '@nestjs/common';
import { GoogleAuthService, GoogleIdentity } from './google-auth.service';

describe('GoogleAuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const jwt = { sign: jest.fn().mockReturnValue('platform-jwt') };
  const config = { get: jest.fn((key: string) => key === 'GOOGLE_CLIENT_ID' ? 'google-client-id' : 'google-client-secret') };

  const identity: GoogleIdentity = {
    googleId: 'google-123',
    email: 'person@example.com',
    emailVerified: true,
    name: 'Person Example',
    avatarUrl: 'https://example.com/avatar.jpg',
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates and consumes single-use OAuth state values', () => {
    const service = new GoogleAuthService(prisma as any, jwt as any, config as any);
    const state = service.createOAuthState();

    expect(service.consumeOAuthState(state)).toBe(true);
    expect(service.consumeOAuthState(state)).toBe(false);
  });

  it('rejects an ID token when Google signature verification fails', async () => {
    const service = new GoogleAuthService(prisma as any, jwt as any, config as any);
    (service as any).googleClient.verifyIdToken = jest.fn().mockRejectedValue(new Error('bad token'));

    await expect(service.verifyIdToken('invalid-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('creates a walletless user and returns a platform JWT', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      stellarAddress: null,
      googleId: identity.googleId,
      role: 'STUDENT',
      ...identity,
    });
    const service = new GoogleAuthService(prisma as any, jwt as any, config as any);

    const result = await service.login(identity);

    expect(prisma.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      googleId: identity.googleId,
      email: identity.email,
      role: 'STUDENT',
    }) });
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({
      sub: 'user-1',
      googleId: identity.googleId,
      stellarAddress: null,
    }));
    expect(result.accessToken).toBe('platform-jwt');
  });

  it('does not allow a client to choose the instructor role', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      stellarAddress: null,
      googleId: identity.googleId,
      role: 'STUDENT',
    });
    const service = new GoogleAuthService(prisma as any, jwt as any, config as any);

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
      });
    prisma.user.update.mockResolvedValue({
      id: 'existing-user',
      stellarAddress: 'GABC',
      googleId: identity.googleId,
      role: 'STUDENT',
    });
    const service = new GoogleAuthService(prisma as any, jwt as any, config as any);

    await service.login(identity);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'existing-user' },
      data: expect.objectContaining({ googleId: identity.googleId }),
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});