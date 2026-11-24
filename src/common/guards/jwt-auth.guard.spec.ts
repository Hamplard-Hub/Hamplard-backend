import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard — deactivated accounts', () => {
  const ctxFor = (user: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => function handler() {},
      getClass: () => class Ctl {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(AuthGuard('jwt').prototype, 'canActivate')
      .mockResolvedValue(true as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('blocks a deactivated account on ordinary routes', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    await expect(guard.canActivate(ctxFor({ id: 'u1', isDeactivated: true }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets a deactivated account through routes marked AllowDeactivated', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    await expect(guard.canActivate(ctxFor({ id: 'u1', isDeactivated: true }))).resolves.toBe(true);
  });

  it('does not affect active accounts', async () => {
    const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    await expect(guard.canActivate(ctxFor({ id: 'u1', isDeactivated: false }))).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it('throws on an invalid token payload (no user id)', async () => {
    const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    await expect(guard.canActivate(ctxFor(null))).rejects.toThrow('Invalid token payload');
  });
});
