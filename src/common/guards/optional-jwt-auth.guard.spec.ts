import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

/**
 * Issue #418 — OptionalJwtAuthGuard must treat a revoked/expired (or otherwise
 * rejected) token as an anonymous caller. The revocation/expiry check itself
 * lives in JwtStrategy.validate (shared with JwtAuthGuard); this guard's only
 * job is to never reject and to surface `request.user = null` when the strategy
 * throws. A strategy throw reaches handleRequest as (err, false), so verifying
 * that path is what guarantees the "revoked token => anonymous" behaviour.
 */
describe('OptionalJwtAuthGuard', () => {
  const guard = new OptionalJwtAuthGuard();

  const ctxWith = (user: any) => {
    const req: any = { user };
    return {
      req,
      context: {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext,
    };
  };

  describe('handleRequest', () => {
    it('surfaces the authenticated user when the strategy succeeds', () => {
      const user = { id: 'user-1', role: 'STUDENT' };
      expect(guard.handleRequest(null, user)).toEqual(user);
    });

    it('returns null when there is no token (anonymous)', () => {
      expect(guard.handleRequest(null, false)).toBeNull();
    });

    it('returns null when the strategy rejects the token (revoked/expired/banned)', () => {
      const err = new Error('Session has been revoked');
      expect(guard.handleRequest(err, false)).toBeNull();
    });
  });

  describe('canActivate', () => {
    beforeEach(() => {
      // Stand in for the full passport + JwtStrategy pipeline: route the mock
      // user straight onto the request so the guard only has to decide
      // reject-vs-anonymous.
      jest
        .spyOn(AuthGuard('jwt').prototype, 'canActivate')
        .mockImplementation(async (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          if (req.__mockUser !== undefined) req.user = req.__mockUser;
          else delete req.user;
          return true;
        });
    });
    afterEach(() => jest.restoreAllMocks());

    it('never rejects an anonymous caller', async () => {
      const { req, context } = ctxWith(undefined);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.user).toBeUndefined();
    });

    it('never rejects an authenticated caller', async () => {
      const user = { id: 'user-1', role: 'STUDENT' };
      const { req, context } = ctxWith(null);
      (req as any).__mockUser = user;
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.user).toEqual(user);
    });
  });
});
