import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = { get: jest.fn().mockReturnValue('access-secret') };

  it('maps an access-token payload onto the request user', async () => {
    const strategy = new JwtStrategy(config as any);

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
      jti: 'access-jti',
    });
  });

  it('rejects a refresh token presented as an access token', async () => {
    const strategy = new JwtStrategy(config as any);

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
