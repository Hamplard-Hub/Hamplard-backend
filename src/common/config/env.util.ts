// env.util.ts
// Environment variables always arrive as strings, so ConfigService.get<boolean>()
// returns e.g. the string "false" — which is truthy. These helpers parse the
// raw value explicitly instead of trusting the generic type parameter.
import { ConfigService } from '@nestjs/config';

const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'off'];

/**
 * Parse a boolean-like value ("true"/"false", "1"/"0", "yes"/"no", "on"/"off").
 * Returns the fallback for missing, empty or unrecognised values.
 */
export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.includes(normalized)) return true;
  if (FALSE_VALUES.includes(normalized)) return false;
  return fallback;
}

/**
 * Parse a numeric value. Returns the fallback for missing, empty or
 * non-numeric values.
 */
export function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value !== 'string' || value.trim() === '') return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read a boolean config key, parsing string env values explicitly. */
export function getBooleanConfig(
  config: ConfigService,
  key: string,
  fallback: boolean,
): boolean {
  return parseBoolean(config.get<unknown>(key), fallback);
}

/** Read a numeric config key, parsing string env values explicitly. */
export function getNumberConfig(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  return parseNumber(config.get<unknown>(key), fallback);
}

/**
 * Express `trust proxy` setting used for `req.ip`.
 *
 * Default is `false` (TCP peer address). `true` is never applied: it would
 * trust arbitrary `X-Forwarded-For` values from clients. Boolean true-like
 * env values are treated as a single hop (`1`), which is appropriate behind
 * one known reverse proxy. Numeric values are hop counts. Any other string
 * is treated as a proxy IP or comma-separated subnet list.
 */
export type TrustProxySetting = false | number | string | string[];

export function parseTrustProxy(value: unknown): TrustProxySetting {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value ? 1 : false;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value <= 0 ? false : Math.floor(value);
  }
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (['false', 'no', 'off', '0'].includes(lower)) return false;
  if (['true', 'yes', 'on'].includes(lower)) return 1;
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return hops === 0 ? false : hops;
  }

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.length === 1 ? parts[0] : parts;
}
