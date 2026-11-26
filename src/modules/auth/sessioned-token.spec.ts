import { issueSessionedTokenPair, trackAccessTokenSession } from './sessioned-token';

describe('sessioned token helpers', () => {
  const user = {
    id: 'user-1',
    stellarAddress: null,
    googleId: 'google-1',
    role: 'STUDENT',
  };

  const jwt = { decode: jest.fn() };
  const sessions = { createSession: jest.fn() };
  const refreshTokens = {
    issueTokenPair: jest.fn().mockResolvedValue({
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.decode.mockReturnValue({
      sub: user.id,
      jti: 'access-jti',
      exp: 1_700_000_000,
    });
  });

  it('issues a token pair and tracks the access-token session in one call', async () => {
    const deviceMeta = { userAgent: 'jest', ipAddress: '127.0.0.1' };

    const tokens = await issueSessionedTokenPair(
      refreshTokens as any,
      jwt as any,
      sessions as any,
      user,
      deviceMeta,
    );

    expect(refreshTokens.issueTokenPair).toHaveBeenCalledWith(user);
    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: user.id,
      jti: 'access-jti',
      expiresAt: new Date(1_700_000_000_000),
      meta: deviceMeta,
    });
    expect(tokens).toEqual({ accessToken: 'access-jwt', refreshToken: 'refresh-jwt' });
  });

  it('falls back to a seven-day session lifetime when the token has no exp', async () => {
    const now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    jwt.decode.mockReturnValue({ sub: user.id, jti: 'access-jti' });

    await trackAccessTokenSession(jwt as any, sessions as any, 'access-jwt');

    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      }),
    );
    nowSpy.mockRestore();
  });

  it.each([
    ['jti', { sub: user.id }],
    ['sub', { jti: 'access-jti' }],
    ['both', null],
  ])('does not create a session without %s', async (_label, decoded) => {
    jwt.decode.mockReturnValue(decoded);

    await trackAccessTokenSession(jwt as any, sessions as any, 'access-jwt');

    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('links the session to the refresh-token familyId (issue #416)', async () => {
    refreshTokens.issueTokenPair.mockResolvedValueOnce({
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
      familyId: 'family-xyz',
    });

    await issueSessionedTokenPair(
      refreshTokens as any,
      jwt as any,
      sessions as any,
      user,
    );

    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        jti: 'access-jti',
        familyId: 'family-xyz',
      }),
    );
  });
});
