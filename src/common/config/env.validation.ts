import 'reflect-metadata';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  validateSync,
  ValidationError,
} from 'class-validator';
import { parseBoolean } from './env.util';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
  Provision = 'provision',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

export class EnvironmentVariables {
  // Server
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsOptional()
  API_PREFIX: string = 'api/v1';

  @IsOptional()
  TRUST_PROXY?: string | number | boolean;

  @IsString()
  @IsOptional()
  APP_BASE_URL: string = 'http://localhost:3000';

  @IsString()
  @IsOptional()
  PUBLIC_API_URL: string = 'http://localhost:3000/api/v1';

  @IsString()
  @IsOptional()
  FRONTEND_URL: string = 'http://localhost:3001';

  @IsString()
  @IsOptional()
  CORS_ORIGIN: string = 'http://localhost:3001';

  @IsEnum(LogLevel)
  @IsOptional()
  LOG_LEVEL: LogLevel = LogLevel.Debug;

  @Transform(({ value }) => parseBoolean(value, false))
  @IsBoolean()
  @IsOptional()
  SWAGGER_ENABLED: boolean = false;

  // Database
  @IsString()
  @IsOptional()
  DATABASE_URL: string = 'postgresql://hamplard:password@localhost:5432/hamplard_db';

  // JWT
  @IsString()
  @IsOptional()
  JWT_SECRET: string = 'dev-super-secret-jwt-key-change-in-production';

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN: string = '7d';

  @IsString()
  @IsOptional()
  JWT_REFRESH_SECRET: string = 'dev-super-secret-refresh-jwt-key-change-in-production';

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRES_IN: string = '30d';

  // Google OAuth
  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_SECRET?: string;

  @IsString()
  @IsOptional()
  GOOGLE_CALLBACK_URL: string = 'http://localhost:3000/api/v1/auth/google/callback';

  // Stellar
  @IsString()
  @IsOptional()
  STELLAR_NETWORK: string = 'testnet';

  @IsString()
  @IsOptional()
  STELLAR_RPC_URL: string = 'https://soroban-testnet.stellar.org';

  @IsString()
  @IsOptional()
  HAMPLARD_CONTRACT_ID?: string;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  EVENT_POLLING_INTERVAL_MS: number = 5000;

  // Redis
  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  @IsString()
  @IsOptional()
  REDIS_HOST: string = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  REDIS_PORT: number = 6379;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CACHE_TTL_SECONDS: number = 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  QUEUE_JOB_ATTEMPTS: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  QUEUE_RETRY_DELAY_MS: number = 5000;

  // Throttling & Rate Limiting
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  THROTTLE_TTL: number = 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  THROTTLE_LIMIT: number = 100;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  RATE_LIMIT_WINDOW_MS: number = 60000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  RATE_LIMIT_STANDARD_MAX: number = 100;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  RATE_LIMIT_SENSITIVE_MAX: number = 10;

  @IsString()
  @IsOptional()
  RATE_LIMIT_EXEMPT_IPS?: string;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  ROLE_THROTTLE_WINDOW_MS: number = 60000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  ROLE_THROTTLE_ANON_LIMIT: number = 20;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  ROLE_THROTTLE_STUDENT_LIMIT: number = 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  ROLE_THROTTLE_INSTRUCTOR_LIMIT: number = 120;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  ROLE_THROTTLE_ADMIN_LIMIT: number = 300;

  // Security / Captcha / OTP
  @IsString()
  @IsOptional()
  OTP_HMAC_SECRET: string = 'change-me-otp-hmac-secret';

  @IsString()
  @IsOptional()
  CAPTCHA_SECRET_KEY?: string;

  @IsString()
  @IsOptional()
  CAPTCHA_VERIFY_URL: string = 'https://www.google.com/recaptcha/api/siteverify';

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  CAPTCHA_TIMEOUT_MS: number = 5000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CAPTCHA_MAX_FAILURES: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CAPTCHA_BLOCK_DURATION_SECONDS: number = 900;

  // TOTP verification (per-account lockout — issue #426)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  TOTP_MAX_FAILED_ATTEMPTS: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @IsOptional()
  TOTP_LOCKOUT_SECONDS: number = 900;

  // Uploads & Storage
  @IsString()
  @IsOptional()
  UPLOAD_DIR: string = './uploads';

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  MAX_FILE_SIZE_MB: number = 500;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  MAX_IMAGE_SIZE_MB: number = 10;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  MAX_DOCUMENT_SIZE_MB: number = 25;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  MAX_KYC_FILE_SIZE_MB: number = 10;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @IsOptional()
  MAX_VIDEO_SIZE_MB: number = 500;

  @Transform(({ value }) => parseBoolean(value, false))
  @IsBoolean()
  @IsOptional()
  VIRUS_SCAN_ENABLED: boolean = false;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  VIRUS_SCAN_MAX_RETRIES: number = 3;

  @IsString()
  @IsOptional()
  CLAMD_HOST: string = '127.0.0.1';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CLAMD_PORT: number = 3310;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @IsOptional()
  CLAMD_TIMEOUT: number = 5000;

  @IsString()
  @IsOptional()
  CDN_BASE_URL?: string;

  @IsString()
  @IsOptional()
  CDN_ORIGIN_BASE_URL?: string;

  @IsString()
  @IsOptional()
  CDN_SIGNING_SECRET?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CDN_SIGNED_URL_TTL_SECONDS: number = 3600;

  /** Lifetime of signed lesson video URLs handed to students (issue #335). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  LESSON_VIDEO_URL_TTL_SECONDS: number = 300;

  @IsString()
  @IsOptional()
  CDN_PURGE_URL?: string;

  @IsString()
  @IsOptional()
  CDN_PURGE_TOKEN?: string;

  @IsString()
  @IsOptional()
  CERTIFICATE_SHARE_IMAGE_URL?: string;

  @IsString()
  @IsOptional()
  FALLBACK_THUMBNAIL_PATH?: string;

  // Email
  @IsString()
  @IsOptional()
  SMTP_HOST?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  SMTP_PORT: number = 587;

  @IsString()
  @IsOptional()
  SMTP_USER?: string;

  @IsString()
  @IsOptional()
  SMTP_PASS?: string;

  @IsString()
  @IsOptional()
  EMAIL_FROM: string = 'noreply@hamplard.com';

  // Africa's Talking (SMS)
  @IsString()
  @IsOptional()
  AFRICASTALKING_USERNAME?: string;

  @IsString()
  @IsOptional()
  AFRICASTALKING_API_KEY?: string;

  @IsString()
  @IsOptional()
  AFRICASTALKING_SENDER_ID: string = 'Hamplard';

  @IsString()
  @IsOptional()
  SMS_WEBHOOK_SECRET?: string;

  // Firebase Push Notifications
  @IsString()
  @IsOptional()
  FIREBASE_PROJECT_ID?: string;

  @IsString()
  @IsOptional()
  FIREBASE_CLIENT_EMAIL?: string;

  @IsString()
  @IsOptional()
  FIREBASE_PRIVATE_KEY?: string;

  // Meilisearch
  @IsString()
  @IsOptional()
  MEILISEARCH_HOST: string = 'http://localhost:7700';

  @IsString()
  @IsOptional()
  MEILISEARCH_API_KEY?: string;

  // Sentry
  @IsString()
  @IsOptional()
  SENTRY_DSN?: string;

  @IsString()
  @IsOptional()
  SENTRY_ENVIRONMENT?: string;

  @IsString()
  @IsOptional()
  SENTRY_RELEASE?: string;

  // Backups
  @Transform(({ value }) => parseBoolean(value, false))
  @IsBoolean()
  @IsOptional()
  BACKUP_ENABLED: boolean = false;

  @IsString()
  @IsOptional()
  BACKUP_S3_BUCKET?: string;

  @IsString()
  @IsOptional()
  BACKUP_S3_PREFIX: string = 'database-backups';

  @IsString()
  @IsOptional()
  BACKUP_S3_ENDPOINT?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  BACKUP_RETENTION_DAYS: number = 30;

  @IsString()
  @IsOptional()
  AWS_REGION: string = 'us-east-1';

  // Audit Log & Cron Monitor
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  AUDIT_LOG_RETENTION_DAYS: number = 90;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CRON_RUN_RETENTION_DAYS: number = 30;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  CRON_STALE_THRESHOLD_MINUTES: number = 60;

  // Webhooks
  @IsString()
  @IsOptional()
  WEBHOOK_SECRET: string = 'change-me-webhook-signing-secret';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  WEBHOOK_TOLERANCE_SECONDS: number = 300;

  @IsString()
  @IsOptional()
  WEBHOOK_SIGNATURE_EXCLUDE_PATHS?: string;

  // Business / Platform / Fraud
  @IsString()
  @IsOptional()
  PLATFORM_NAME: string = 'Hamplard';

  /** Postal address printed on invoices (issue #334). */
  @IsString()
  @IsOptional()
  PLATFORM_ADDRESS?: string;

  /** Tax / VAT registration number printed on invoices (issue #334). */
  @IsString()
  @IsOptional()
  PLATFORM_TAX_ID?: string;

  /** HMAC secret for signing checkout quotes; falls back to JWT_SECRET (issue #333). */
  @IsString()
  @IsOptional()
  CHECKOUT_QUOTE_SECRET?: string;

  /** How long a checkout quote stays valid, in seconds (issue #333). */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @IsOptional()
  CHECKOUT_QUOTE_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  PLATFORM_FEE_PERCENT: number = 20;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  FRAUD_WINDOW_HOURS: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  FRAUD_MAX_ENROLLMENTS_PER_WINDOW: number = 3;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  FRAUD_MAX_DAILY_ENROLLMENTS: number = 10;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  FRAUD_MAX_ACTIVE_ENROLLMENTS: number = 20;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  FRAUD_HIGH_AMOUNT_THRESHOLD_USDC: number = 500;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  FRAUD_HIGH_RISK_SCORE_THRESHOLD: number = 70;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  FRAUD_CRITICAL_SCORE_THRESHOLD: number = 90;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  REFERRAL_REFERRER_DISCOUNT_PERCENT: number = 10;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  REFERRAL_REFEREE_DISCOUNT_PERCENT: number = 10;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  REFERRAL_REWARD_EXPIRY_DAYS: number = 90;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  REFERRAL_MAX_REWARDS_PER_REFERRER: number = 50;
}

/**
 * Validates the raw configuration object using class-validator and class-transformer.
 * Enforces production-specific requirements and returns typed, converted values.
 */
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
    whitelist: false,
  });

  const validationErrors: string[] = [];

  if (errors.length > 0) {
    for (const err of errors) {
      const constraints = Object.values(err.constraints || {}).join(', ');
      validationErrors.push(`- ${err.property}: ${constraints} (received: ${JSON.stringify(err.value)})`);
    }
  }

  // Strict checks for production environment
  if (validatedConfig.NODE_ENV === Environment.Production) {
    const isPlaceholderSecret = (val?: string) =>
      !val ||
      val.includes('change-in-production') ||
      val.includes('change-me') ||
      val === 'your-super-secret-jwt-key-change-in-production';

    if (isPlaceholderSecret(validatedConfig.JWT_SECRET)) {
      validationErrors.push('- JWT_SECRET: must be set to a secure, non-default value in production');
    }
    if (isPlaceholderSecret(validatedConfig.JWT_REFRESH_SECRET)) {
      validationErrors.push('- JWT_REFRESH_SECRET: must be set to a secure, non-default value in production');
    }
    if (!config.DATABASE_URL) {
      validationErrors.push('- DATABASE_URL: must be explicitly provided in production');
    }
    if (!config.STELLAR_RPC_URL) {
      validationErrors.push('- STELLAR_RPC_URL: must be explicitly provided in production');
    }
    if (!config.HAMPLARD_CONTRACT_ID) {
      validationErrors.push('- HAMPLARD_CONTRACT_ID: must be explicitly provided in production');
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `\n========================================\n` +
      `ENVIRONMENT CONFIGURATION ERROR:\n` +
      `The following environment variables failed validation:\n` +
      validationErrors.join('\n') +
      `\nPlease update your environment variables or .env file.\n` +
      `========================================\n`,
    );
  }

  return validatedConfig;
}
