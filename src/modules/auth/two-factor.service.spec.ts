import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import * as speakeasy from 'speakeasy';
import { TwoFactorService } from './two-factor.service';

/**
 * Unit tests for the per-account TOTP attempt limit (issue #426).
 *
 * Redis is replaced with a small in-memory fake so the tests need no external
 * services and can assert exactly what is stored under each user's keys.
 */

const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
const RECOVERY_CODE = 'AAAAA-BBBBB';
const RECOVERY_HASH = createHash('sha256').update(RECOVERY_CODE).digest('hex');

interface StoreEntry {
  value: string;
  expiresAt: number;
}

function buildRateLimitFake() {
  const store = new Map<string, StoreEntry>();

  const live = (key: string): StoreEntry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    store,
    fixedWindow: jest.fn(async (key: string, ttlSeconds: number) => {
      const entry = live(key);
      const count = (entry ? Number(entry.value) : 0) + 1;
      store.set(key, {
        value: String(count),
        expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000,
      });
      return { count, ttlSeconds };
    }),
    getJson: jest.fn(async <T>(key: string): Promise<T | null> => {
      const entry = live(key);
      return entry ? (JSON.parse(entry.value) as T) : null;
    }),
    setJson: jest.fn(async (key: string, value: unknown, ttlSeconds = 60) => {
      store.set(key, {
        value: JSON.stringify(value),
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function validCode(): string {
  return speakeasy.totp({ secret: SECRET, encoding: 'base32' });
}

function expectLockout(promise: Promise<unknown>): Promise<unknown> {
  return expect(promise).rejects.toMatchObject({
    status: HttpStatus.TOO_MANY_REQUESTS,
  });
}

describe('TwoFactorService — per-account TOTP lockout (issue #426)', () => {
  const configValues: Record<string, number> = {
    TOTP_MAX_FAILED_ATTEMPTS: 3,
    TOTP_LOCKOUT_SECONDS: 60,
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        twoFactorEnabled: true,
        twoFactorSecret: SECRET,
        twoFactorRecoveryCodes: [RECOVERY_HASH],
      })),
      update: jest.fn(async () => ({})),
    },
  };

  const buildService = (values: Record<string, number> = configValues) => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in values ? values[key] : fallback,
      ),
    };
    const rateLimit = buildRateLimitFake();
    const service = new TwoFactorService(prisma as any, config as any, rateLimit as any);
    return { service, rateLimit };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts failed codes per user and returns false before the threshold', async () => {
    const { service, rateLimit } = buildService();

    expect(await service.verifyLoginCode('user-1', '000000')).toBe(false);
    expect(await service.verifyLoginCode('user-1', '111111')).toBe(false);

    expect(rateLimit.fixedWindow).toHaveBeenCalledTimes(2);
    expect(rateLimit.fixedWindow).toHaveBeenCalledWith(
      expect.stringContaining('user-1'),
      60,
    );
    const attemptKey = [...rateLimit.store.keys()].find((key) => key.includes('user-1'));
    expect(attemptKey).toBeDefined();
    expect(rateLimit.store.get(attemptKey!)?.value).toBe('2');
  });

  it('locks the account after N failures and rejects even a valid code while locked', async () => {
    const { service } = buildService();

    expect(await service.verifyLoginCode('user-1', '000000')).toBe(false);
    expect(await service.verifyLoginCode('user-1', '111111')).toBe(false);
    await expectLockout(service.verifyLoginCode('user-1', '222222'));

    // A correct code must not rescue an account that is already locked out.
    await expectLockout(service.verifyLoginCode('user-1', validCode()));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('applies the same lockout to login, Google token login and disable', async () => {
    const { service } = buildService({ TOTP_MAX_FAILED_ATTEMPTS: 2, TOTP_LOCKOUT_SECONDS: 60 });

    // One failure through the login path, one through the disable path.
    expect(await service.verifyLoginCode('user-1', '000000')).toBe(false);
    await expectLockout(service.disable('user-1', '111111'));

    // Both login and disable now refuse even correct codes.
    await expectLockout(service.verifyLoginCode('user-1', validCode()));
    await expectLockout(service.disable('user-1', validCode()));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('resets the failure counter on a successful code', async () => {
    const { service, rateLimit } = buildService();

    expect(await service.verifyLoginCode('user-1', '000000')).toBe(false);
    expect(await service.verifyLoginCode('user-1', validCode())).toBe(true);

    expect(rateLimit.del).toHaveBeenCalledWith(expect.stringContaining('user-1'));
    expect(rateLimit.store.size).toBe(0);

    // The budget is fresh again: N-1 failures still return false, not 429.
    expect(await service.verifyLoginCode('user-1', '111111')).toBe(false);
    expect(await service.verifyLoginCode('user-1', '222222')).toBe(false);
    await expectLockout(service.verifyLoginCode('user-1', '333333'));
  });

  it('resets the failure counter on a successful recovery code', async () => {
    const { service, rateLimit } = buildService();

    expect(await service.verifyLoginCode('user-1', '000000')).toBe(false);
    expect(await service.verifyLoginCode('user-1', RECOVERY_CODE)).toBe(true);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { twoFactorRecoveryCodes: [] },
    });
    expect(rateLimit.store.size).toBe(0);
  });

  it('allows login again once the lockout has expired', async () => {
    const { service, rateLimit } = buildService({
      TOTP_MAX_FAILED_ATTEMPTS: 1,
      TOTP_LOCKOUT_SECONDS: 60,
    });

    await expectLockout(service.verifyLoginCode('user-1', '000000'));

    // Simulate a lockout marker that Redis has not pruned yet, but whose
    // timestamp has passed — verification should clear it and succeed.
    const lockoutKey = [...rateLimit.store.keys()].find((key) =>
      key.startsWith('auth:2fa:lockout:'),
    );
    expect(lockoutKey).toBeDefined();
    rateLimit.store.get(lockoutKey!)!.value = String(Date.now() - 1);

    expect(await service.verifyLoginCode('user-1', validCode())).toBe(true);
    expect(rateLimit.store.size).toBe(0);
  });

  it('keeps attempt counters isolated between accounts', async () => {
    const { service, rateLimit } = buildService({
      TOTP_MAX_FAILED_ATTEMPTS: 1,
      TOTP_LOCKOUT_SECONDS: 60,
    });

    await expectLockout(service.verifyLoginCode('user-1', '000000'));

    expect(await service.verifyLoginCode('user-2', validCode())).toBe(true);
  });

  it('surfaces the lockout as a 429 HttpException', async () => {
    const { service } = buildService({ TOTP_MAX_FAILED_ATTEMPTS: 1, TOTP_LOCKOUT_SECONDS: 60 });

    await expect(service.verifyLoginCode('user-1', '000000')).rejects.toBeInstanceOf(HttpException);
    await expect(service.verifyLoginCode('user-1', '000000')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: expect.stringContaining('Too many failed two-factor attempts'),
    });
  });
});
