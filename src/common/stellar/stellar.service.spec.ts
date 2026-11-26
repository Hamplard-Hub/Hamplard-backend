import { StellarService, CONTRACT_EVENT_PAGE_LIMIT } from './stellar.service';
import { ConfigService } from '@nestjs/config';

// Note: StellarService.verifyEnrollmentTransaction is removed (dead code, unsafe).
// Enrollment verification should match on txHash, the `student_enrolled` topic and the student address.

describe('StellarService.onModuleInit', () => {
  const createService = (config: Record<string, string | undefined>) =>
    new StellarService({
      get: (key: string) => config[key],
    } as ConfigService);

  it('allows HTTP for localhost RPC endpoints', async () => {
    const service = createService({
      STELLAR_NETWORK: 'testnet',
      STELLAR_RPC_URL: 'http://localhost:8000',
      HAMPLARD_CONTRACT_ID: 'CONTRACT',
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.getContractId()).toBe('CONTRACT');
  });

  it('allows HTTP for standalone RPC endpoints and uses the standalone passphrase', async () => {
    const service = createService({
      STELLAR_NETWORK: 'standalone',
      STELLAR_RPC_URL: 'http://stellar-node:8000',
      HAMPLARD_CONTRACT_ID: 'CONTRACT',
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.getNetworkPassphrase()).toBe('Standalone Network ; February 2017');
  });

  it('rejects HTTP RPC URLs for mainnet', async () => {
    const service = createService({
      STELLAR_NETWORK: 'mainnet',
      STELLAR_RPC_URL: 'http://localhost:8000',
      HAMPLARD_CONTRACT_ID: 'CONTRACT',
    });

    await expect(service.onModuleInit()).rejects.toThrow(/not allowed for the Stellar mainnet/);
  });

  it('rejects HTTP RPC URLs for remote testnet endpoints', async () => {
    const service = createService({
      STELLAR_NETWORK: 'testnet',
      STELLAR_RPC_URL: 'http://rpc.example.com',
      HAMPLARD_CONTRACT_ID: 'CONTRACT',
    });

    await expect(service.onModuleInit()).rejects.toThrow(/only allowed for localhost or the standalone network/);
  });

  it.each([
    [{ STELLAR_NETWORK: 'typo', STELLAR_RPC_URL: 'https://rpc.example.com', HAMPLARD_CONTRACT_ID: 'CONTRACT' }, /Invalid STELLAR_NETWORK/],
    [{ STELLAR_NETWORK: 'testnet', HAMPLARD_CONTRACT_ID: 'CONTRACT' }, /STELLAR_RPC_URL is required/],
    [{ STELLAR_NETWORK: 'testnet', STELLAR_RPC_URL: 'https://rpc.example.com' }, /HAMPLARD_CONTRACT_ID is required/],
  ])('fails fast for invalid or missing configuration', async (config, error) => {
    const service = createService(config);
    await expect(service.onModuleInit()).rejects.toThrow(error);
  });
});

describe('StellarService.fetchContractEvents', () => {
  it('uses the last event paging token instead of startLedger for the next page', async () => {
    const service = new StellarService({} as any);
    const getEvents = jest.fn().mockResolvedValue({ latestLedger: 500, events: [] });
    (service as any).rpcClient = { getEvents };
    (service as any).contractId = 'CONTRACT';

    await service.fetchContractEvents(490);
    await service.fetchContractEvents(501, 'token-99');

    expect(getEvents).toHaveBeenNthCalledWith(1, {
      startLedger: 490,
      filters: [{ type: 'contract', contractIds: ['CONTRACT'] }],
      limit: CONTRACT_EVENT_PAGE_LIMIT,
    });
    expect(getEvents).toHaveBeenNthCalledWith(2, {
      cursor: 'token-99',
      filters: [{ type: 'contract', contractIds: ['CONTRACT'] }],
      limit: CONTRACT_EVENT_PAGE_LIMIT,
    });
  });
});

describe('StellarService USDC/stroops conversions', () => {
  const service = new StellarService({} as any);

  it.each([
    ['0', 0n],
    ['1.5', 15_000_000n],
    ['-1.5', -15_000_000n],
    ['+0.0000001', 1n],
    ['-0.0000001', -1n],
    ['12345678901234567890.1234567', 123456789012345678901234567n],
  ])('converts %s USDC to exact stroops', (input, expected) => {
    expect(service.usdcToStroops(input as string)).toBe(expected);
  });

  it.each(['1.00000001', '1.2.3', 'abc', '', '  ', '0x10'])('rejects malformed USDC amount %s', (input) => {
    expect(() => service.usdcToStroops(input)).toThrow(TypeError);
  });

  it('rejects non-finite numeric USDC input', () => {
    expect(() => service.usdcToStroops(Number.NaN)).toThrow(TypeError);
    expect(() => service.usdcToStroops(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it.each(['0', '1.5', '-1.5', '0.0000001', '-12345678901234567890.1234567'])
    ('round-trips valid decimal amount %s exactly', (amount) => {
      const stroops = service.usdcToStroops(amount);
      const formatted = service.stroopsToUsdc(stroops, 7);
      expect(service.usdcToStroops(formatted)).toBe(stroops);
    });

  it('formats large positive and negative balances without floating-point loss', () => {
    expect(service.stroopsToUsdc('123456789012345678901234567890', 7))
      .toBe('12345678901234567890123.4567890');
    expect(service.stroopsToUsdc('-123456789012345678901234567890', 7))
      .toBe('-12345678901234567890123.4567890');
  });

  it('rounds to requested decimal places using integer arithmetic', () => {
    expect(service.stroopsToUsdc('14999999')).toBe('1.50');
    expect(service.stroopsToUsdc('-14999999')).toBe('-1.50');
    expect(service.stroopsToUsdc('1234567', 2)).toBe('0.12');
  });

  it('validates stroops and formatting precision', () => {
    expect(() => service.stroopsToUsdc('1.5')).toThrow(TypeError);
    expect(() => service.stroopsToUsdc('1', -1)).toThrow(RangeError);
    expect(() => service.stroopsToUsdc('1', 1.5)).toThrow(RangeError);
  });
});
