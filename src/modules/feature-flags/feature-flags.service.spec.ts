import { FeatureFlagsService } from './feature-flags.service';

describe('FeatureFlagsService evaluation cache', () => {
  const prisma = {
    featureFlag: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  let service: FeatureFlagsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeatureFlagsService(prisma as any);
    prisma.featureFlag.findUnique.mockResolvedValue({
      key: 'google_login',
      enabled: true,
      rolloutPercent: 100,
      allowedRoles: [],
      allowedUserIds: [],
    });
  });

  it('caches evaluations for the same key and user briefly', async () => {
    await expect(
      service.isEnabled('google_login', { userId: 'user-1' }),
    ).resolves.toBe(true);
    await expect(
      service.isEnabled('google_login', { userId: 'user-1' }),
    ).resolves.toBe(true);

    expect(prisma.featureFlag.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached evaluations when a flag is updated', async () => {
    await service.isEnabled('google_login', { userId: 'user-1' });
    prisma.featureFlag.update.mockResolvedValue({
      key: 'google_login',
      enabled: false,
    });

    await service.update('google_login', { enabled: false });
    prisma.featureFlag.findUnique.mockResolvedValue({
      key: 'google_login',
      enabled: false,
      rolloutPercent: 100,
      allowedRoles: [],
      allowedUserIds: [],
    });

    await expect(
      service.isEnabled('google_login', { userId: 'user-1' }),
    ).resolves.toBe(false);
    expect(prisma.featureFlag.findUnique).toHaveBeenCalledTimes(3);
  });
});
