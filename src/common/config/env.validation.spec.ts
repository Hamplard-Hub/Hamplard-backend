import { validate, Environment, LogLevel } from './env.validation';

describe('Environment Validation', () => {
  it('parses a valid default development configuration', () => {
    const raw = {
      NODE_ENV: 'development',
      PORT: '3000',
      DATABASE_URL: 'postgresql://localhost:5432/hamplard_db',
    };

    const validated = validate(raw);
    expect(validated.NODE_ENV).toBe(Environment.Development);
    expect(validated.PORT).toBe(3000);
    expect(typeof validated.PORT).toBe('number');
    expect(validated.DATABASE_URL).toBe('postgresql://localhost:5432/hamplard_db');
  });

  it('correctly converts boolean and numeric env strings', () => {
    const raw = {
      PORT: '8080',
      VIRUS_SCAN_ENABLED: 'true',
      BACKUP_ENABLED: '1',
      SWAGGER_ENABLED: 'yes',
      CACHE_TTL_SECONDS: '120',
    };

    const validated = validate(raw);
    expect(validated.PORT).toBe(8080);
    expect(validated.VIRUS_SCAN_ENABLED).toBe(true);
    expect(validated.BACKUP_ENABLED).toBe(true);
    expect(validated.SWAGGER_ENABLED).toBe(true);
    expect(validated.CACHE_TTL_SECONDS).toBe(120);
  });

  it('fails fast when numeric fields contain invalid non-numeric strings', () => {
    const raw = {
      PORT: 'not-a-number',
    };

    expect(() => validate(raw)).toThrow(/PORT/);
  });

  it('fails fast when enum values are invalid', () => {
    const raw = {
      LOG_LEVEL: 'super-verbose',
    };

    expect(() => validate(raw)).toThrow(/LOG_LEVEL/);
  });

  it('fails fast in production if required variables are missing or use default secrets', () => {
    const raw = {
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-super-secret-jwt-key-change-in-production',
    };

    expect(() => validate(raw)).toThrow(/JWT_SECRET: must be set to a secure, non-default value in production/);
  });

  it('passes in production when all production requirements are satisfied', () => {
    const raw = {
      NODE_ENV: 'production',
      JWT_SECRET: 'super-secure-production-secret-1234567890',
      JWT_REFRESH_SECRET: 'super-secure-production-refresh-secret-1234567890',
      DATABASE_URL: 'postgresql://prod_user:prod_pass@db.hamplard.com:5432/hamplard_prod',
      STELLAR_RPC_URL: 'https://soroban-rpc.mainnet.stellar.org',
      HAMPLARD_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };

    const validated = validate(raw);
    expect(validated.NODE_ENV).toBe(Environment.Production);
    expect(validated.JWT_SECRET).toBe('super-secure-production-secret-1234567890');
  });
});
