// logger.module.ts
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

// Request/response fields that must never reach the logs verbatim.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.signature',
  'req.body.signedNonce',
  'req.body.totpCode',
  'req.body.code',
  'req.body.password',
  'req.body.secret',
  'req.body.twoFactorSecret',
  'req.body.recoveryCodes',
  'req.body.accessToken',
  '*.password',
  '*.secret',
  '*.accessToken',
  '*.twoFactorSecret',
  '*.twoFactorRecoveryCodes',
];

function resolveLogLevel(config: ConfigService, nodeEnv: string): string {
  const defaultLevel = nodeEnv === 'production' ? 'info' : 'debug';
  const configured = config.get<string>('LOG_LEVEL');
  if (!configured) return defaultLevel;

  if (!VALID_LOG_LEVELS.includes(configured)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[LoggerModule] Invalid LOG_LEVEL "${configured}" for environment "${nodeEnv}" — falling back to "${defaultLevel}". ` +
        `Valid levels: ${VALID_LOG_LEVELS.join(', ')}.`,
    );
    return defaultLevel;
  }

  return configured;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const nodeEnv = config.get<string>('NODE_ENV', 'development');
        const level = resolveLogLevel(config, nodeEnv);

        return {
          pinoHttp: {
            level,
            genReqId: (req: any, res: any) => {
              const existing = req.headers['x-correlation-id'];
              const correlationId = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
              res.setHeader('x-correlation-id', correlationId);
              return correlationId;
            },
            customProps: (req: any) => ({ correlationId: req.id }),
            redact: {
              paths: REDACTED_PATHS,
              censor: '[REDACTED]',
            },
            // No transport is configured — pino always emits newline-delimited JSON.
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
