import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment, EnvironmentVariables, LogLevel } from './env.validation';
import { parseTrustProxy, TrustProxySetting } from './env.util';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables>) {}

  get nodeEnv(): Environment {
    return (this.config.get('NODE_ENV') as Environment) ?? Environment.Development;
  }

  get isProduction(): boolean {
    return this.nodeEnv === Environment.Production;
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === Environment.Development;
  }

  get isTest(): boolean {
    return this.nodeEnv === Environment.Test;
  }

  get port(): number {
    return Number(this.config.get('PORT')) || 3000;
  }

  get apiPrefix(): string {
    return this.config.get('API_PREFIX') ?? 'api/v1';
  }

  get trustProxy(): TrustProxySetting {
    return parseTrustProxy(this.config.get('TRUST_PROXY'));
  }

  get appBaseUrl(): string {
    return this.config.get('APP_BASE_URL') ?? 'http://localhost:3000';
  }

  get publicApiUrl(): string {
    return this.config.get('PUBLIC_API_URL') ?? 'http://localhost:3000/api/v1';
  }

  get frontendUrl(): string {
    return this.config.get('FRONTEND_URL') ?? 'http://localhost:3001';
  }

  get corsOrigin(): string {
    return this.config.get('CORS_ORIGIN') ?? 'http://localhost:3001';
  }

  get logLevel(): LogLevel {
    return (this.config.get('LOG_LEVEL') as LogLevel) ?? LogLevel.Debug;
  }

  get isSwaggerEnabled(): boolean {
    const swagger = this.config.get('SWAGGER_ENABLED');
    return Boolean(swagger) || (!this.isProduction && swagger !== false);
  }

  get databaseUrl(): string {
    return this.config.get('DATABASE_URL') ?? '';
  }

  get jwtSecret(): string {
    return this.config.get('JWT_SECRET') ?? '';
  }

  get jwtExpiresIn(): string {
    return this.config.get('JWT_EXPIRES_IN') ?? '7d';
  }

  get jwtRefreshSecret(): string {
    return this.config.get('JWT_REFRESH_SECRET') ?? '';
  }

  get jwtRefreshExpiresIn(): string {
    return this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '30d';
  }

  get googleClientId(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_ID');
  }

  get googleClientSecret(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_SECRET');
  }

  get googleCallbackUrl(): string {
    return this.config.get('GOOGLE_CALLBACK_URL') ?? 'http://localhost:3000/api/v1/auth/google/callback';
  }

  get stellarNetwork(): string {
    return this.config.get('STELLAR_NETWORK') ?? 'testnet';
  }

  get stellarRpcUrl(): string {
    return this.config.get('STELLAR_RPC_URL') ?? 'https://soroban-testnet.stellar.org';
  }

  get hamplardContractId(): string | undefined {
    return this.config.get('HAMPLARD_CONTRACT_ID');
  }

  get eventPollingIntervalMs(): number {
    return Number(this.config.get('EVENT_POLLING_INTERVAL_MS')) || 5000;
  }

  get redisUrl(): string | undefined {
    return this.config.get('REDIS_URL');
  }

  get redisHost(): string {
    return this.config.get('REDIS_HOST') ?? 'localhost';
  }

  get redisPort(): number {
    return Number(this.config.get('REDIS_PORT')) || 6379;
  }

  get redisPassword(): string | undefined {
    return this.config.get('REDIS_PASSWORD');
  }

  get cacheTtlSeconds(): number {
    return Number(this.config.get('CACHE_TTL_SECONDS')) || 60;
  }

  get uploadDir(): string {
    return this.config.get('UPLOAD_DIR') ?? './uploads';
  }

  get maxFileSizeMb(): number {
    return Number(this.config.get('MAX_FILE_SIZE_MB')) || 500;
  }

  get virusScanEnabled(): boolean {
    return Boolean(this.config.get('VIRUS_SCAN_ENABLED'));
  }

  get clamdHost(): string {
    return this.config.get('CLAMD_HOST') ?? '127.0.0.1';
  }

  get clamdPort(): number {
    return Number(this.config.get('CLAMD_PORT')) || 3310;
  }

  get backupEnabled(): boolean {
    return Boolean(this.config.get('BACKUP_ENABLED'));
  }

  get backupS3Bucket(): string | undefined {
    return this.config.get('BACKUP_S3_BUCKET');
  }

  get platformName(): string {
    return this.config.get('PLATFORM_NAME') ?? 'Hamplard';
  }

  get platformFeePercent(): number {
    return Number(this.config.get('PLATFORM_FEE_PERCENT')) || 20;
  }

  /**
   * Type-safe arbitrary config reader fallback.
   */
  get<T = any>(key: string): T | undefined {
    return (this.config as unknown as ConfigService).get<T>(key);
  }
}

/**
 * Convenient alias for AppConfigService
 */
export { AppConfigService as AppConfig };
