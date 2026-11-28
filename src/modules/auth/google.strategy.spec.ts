import { UnauthorizedException } from '@nestjs/common';
import { GoogleStrategy } from './google.strategy';

describe('GoogleStrategy', () => {
  const googleAuth = { verifyIdToken: jest.fn() };
  const strategy = new GoogleStrategy(
    { get: jest.fn((_key: string, fallback?: string) => fallback ?? 'configured') } as any,
    googleAuth as any,
  );
  const profile = {
    id: 'google-1',
    emails: [{ value: 'user@example.com', verified: true }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires an ID token from Google', async () => {
    await expect(strategy.validate({}, 'access', '', {}, profile as any, jest.fn())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects unverified emails and mismatched Google identities', async () => {
    googleAuth.verifyIdToken.mockResolvedValue({
      googleId: 'google-1',
      email: 'user@example.com',
    });
    await expect(
      strategy.validate({}, 'access', '', { id_token: 'id-token' }, { ...profile, emails: [] } as any, jest.fn()),
    ).rejects.toThrow('A verified Google email is required');

    googleAuth.verifyIdToken.mockResolvedValue({
      googleId: 'another-google-id',
      email: 'user@example.com',
    });
    await expect(
      strategy.validate({}, 'access', '', { id_token: 'id-token' }, profile as any, jest.fn()),
    ).rejects.toThrow('A verified Google email is required');
  });

  it('returns the verified Google identity', async () => {
    const identity = { googleId: 'google-1', email: 'user@example.com' };
    googleAuth.verifyIdToken.mockResolvedValue(identity);

    await expect(
      strategy.validate({}, 'access', '', { id_token: 'id-token' }, profile as any, jest.fn()),
    ).resolves.toBe(identity);
  });
});
