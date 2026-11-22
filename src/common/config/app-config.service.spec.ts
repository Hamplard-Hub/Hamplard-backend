import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { Environment, LogLevel } from './env.validation';

describe('AppConfigService', () => {
  let appConfig: AppConfigService;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        const values: Record<string, any> = {
          NODE_ENV: Environment.Development,
          PORT: 4000,
          API_PREFIX: 'api/v1',
          DATABASE_URL: 'postgresql://localhost:5432/test',
          JWT_SECRET: 'test-jwt-secret',
          VIRUS_SCAN_ENABLED: true,
          LOG_LEVEL: LogLevel.Info,
          REDIS_PORT: 6380,
        };
        return values[key];
      }),
    };

    appConfig = new AppConfigService(mockConfigService as any);
  });

  it('exposes typed getters for environment configuration', () => {
    expect(appConfig.nodeEnv).toBe(Environment.Development);
    expect(appConfig.isDevelopment).toBe(true);
    expect(appConfig.isProduction).toBe(false);
    expect(appConfig.port).toBe(4000);
    expect(appConfig.apiPrefix).toBe('api/v1');
    expect(appConfig.databaseUrl).toBe('postgresql://localhost:5432/test');
    expect(appConfig.jwtSecret).toBe('test-jwt-secret');
    expect(appConfig.virusScanEnabled).toBe(true);
    expect(appConfig.logLevel).toBe(LogLevel.Info);
    expect(appConfig.redisPort).toBe(6380);
  });
});
