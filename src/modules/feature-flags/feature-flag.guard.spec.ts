import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard } from './feature-flag.guard';
import { FeatureFlagsService } from './feature-flags.service';
import { RequireFeature } from './require-feature.decorator';

class FeatureController {
  @RequireFeature('google_login')
  handler() {}
}

describe('FeatureFlagGuard', () => {
  const reflector = new Reflector();
  const flags = { isEnabled: jest.fn() };
  const guard = new FeatureFlagGuard(
    reflector,
    flags as unknown as FeatureFlagsService,
  );
  const context = {
    getHandler: () => FeatureController.prototype.handler,
    getClass: () => FeatureController,
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 'user-1', role: 'STUDENT' } }),
    }),
  } as unknown as ExecutionContext;

  beforeEach(() => jest.clearAllMocks());

  it('passes the current user context to evaluation when enabled', async () => {
    flags.isEnabled.mockResolvedValue(true);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('google_login', {
      userId: 'user-1',
      role: 'STUDENT',
    });
  });

  it('returns 404 for endpoints whose feature is disabled', async () => {
    flags.isEnabled.mockResolvedValue(false);

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
  });
});
