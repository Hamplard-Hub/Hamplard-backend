import { ConfigService } from '@nestjs/config';
import {
  getBooleanConfig,
  getNumberConfig,
  parseBoolean,
  parseNumber,
  parseTrustProxy,
} from './env.util';

describe('env.util', () => {
  describe('parseBoolean()', () => {
    it.each(['true', 'TRUE', ' 1 ', 'yes', 'on'])('parses %p as true', (value) => {
      expect(parseBoolean(value, false)).toBe(true);
    });

    it.each(['false', 'FALSE', ' 0 ', 'no', 'off'])('parses %p as false', (value) => {
      expect(parseBoolean(value, true)).toBe(false);
    });

    it('passes real booleans through', () => {
      expect(parseBoolean(true, false)).toBe(true);
      expect(parseBoolean(false, true)).toBe(false);
    });

    it.each([undefined, null, '', '   ', 'maybe'])(
      'falls back for %p',
      (value) => {
        expect(parseBoolean(value, true)).toBe(true);
        expect(parseBoolean(value, false)).toBe(false);
      },
    );
  });

  describe('parseNumber()', () => {
    it('parses numeric strings', () => {
      expect(parseNumber('42', 1)).toBe(42);
      expect(parseNumber(' 2.5 ', 1)).toBe(2.5);
    });

    it('passes real numbers through', () => {
      expect(parseNumber(7, 1)).toBe(7);
    });

    it.each([undefined, null, '', 'abc', NaN])('falls back for %p', (value) => {
      expect(parseNumber(value, 10)).toBe(10);
    });
  });

  describe('ConfigService helpers', () => {
    const makeConfig = (values: Record<string, unknown>) =>
      ({ get: jest.fn((key: string) => values[key]) }) as unknown as ConfigService;

    it('reads "false" from the environment as false', () => {
      const config = makeConfig({ VIRUS_SCAN_ENABLED: 'false' });
      expect(getBooleanConfig(config, 'VIRUS_SCAN_ENABLED', true)).toBe(false);
    });

    it('uses the fallback when the key is unset', () => {
      const config = makeConfig({});
      expect(getBooleanConfig(config, 'VIRUS_SCAN_ENABLED', true)).toBe(true);
      expect(getNumberConfig(config, 'MAX_FILE_SIZE_MB', 500)).toBe(500);
    });

    it('reads numeric strings as numbers', () => {
      const config = makeConfig({ MAX_FILE_SIZE_MB: '25' });
      expect(getNumberConfig(config, 'MAX_FILE_SIZE_MB', 500)).toBe(25);
    });
  });

  describe('parseTrustProxy()', () => {
    it('defaults to false so forwarded headers are not trusted', () => {
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy('')).toBe(false);
      expect(parseTrustProxy('false')).toBe(false);
    });

    it('maps true-like values to a single hop instead of trusting every proxy', () => {
      expect(parseTrustProxy(true)).toBe(1);
      expect(parseTrustProxy('true')).toBe(1);
    });

    it('accepts hop counts and explicit proxy addresses', () => {
      expect(parseTrustProxy('1')).toBe(1);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('127.0.0.1')).toBe('127.0.0.1');
      expect(parseTrustProxy('10.0.0.1, 10.0.0.2')).toEqual(['10.0.0.1', '10.0.0.2']);
    });
  });
});
