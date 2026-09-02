import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DB_BACKUP_S3_CLIENT } from './backups.constants';

export type BackupRunState = 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface BackupRunStatus {
  state: BackupRunState;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  dumpDurationMs?: number;
  sizeBytes?: number;
  objectKey?: string;
  message?: string;
}

interface DatabaseConnection {
  hostname: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sslMode?: string;
}

@Injectable()
export class DbBackupService {
  private readonly logger = new Logger(DbBackupService.name);
  private backupInProgress = false;
  private lastRunStatus: BackupRunStatus | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(DB_BACKUP_S3_CLIENT) private readonly s3Client: S3Client,
  ) {}

  @Cron('0 0 2 * * *', {
    name: 'nightly-database-backup',
    timeZone: 'UTC',
  })
  async handleScheduledBackup(): Promise<BackupRunStatus> {
    return this.runBackup();
  }

  async runBackup(): Promise<BackupRunStatus> {
    const startedAt = new Date();

    if (!this.isBackupEnabled()) {
      return this.recordSkippedRun(startedAt, 'Database backups are disabled');
    }

    if (this.backupInProgress) {
      return this.recordSkippedRun(
        startedAt,
        'A database backup is already in progress',
      );
    }

    this.backupInProgress = true;
    let temporaryDirectory: string | undefined;
    let dumpDurationMs: number | undefined;
    let sizeBytes: number | undefined;
    let objectKey: string | undefined;

    this.logger.log(`Database backup started at ${startedAt.toISOString()}`);

    try {
      const databaseUrl = this.getRequiredConfig('DATABASE_URL');
      const bucket = this.getRequiredConfig('BACKUP_S3_BUCKET');
      const prefix = this.getObjectPrefix();
      const connection = this.parseDatabaseUrl(databaseUrl);

      temporaryDirectory = await mkdtemp(join(tmpdir(), 'hamplard-db-backup-'));
      const fileName = `hamplard-${this.toFileTimestamp(startedAt)}.dump`;
      const dumpPath = join(temporaryDirectory, fileName);
      objectKey = `${prefix}/${fileName}`;

      const dumpStartedAt = Date.now();
      await this.createDump(connection, dumpPath);
      dumpDurationMs = Date.now() - dumpStartedAt;

      const dumpStats = await stat(dumpPath);
      if (!dumpStats.isFile() || dumpStats.size === 0) {
        throw new Error('pg_dump created an empty backup archive');
      }
      sizeBytes = dumpStats.size;

      await this.validateDump(dumpPath);
      const checksum = await this.calculateChecksum(dumpPath);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: createReadStream(dumpPath),
          ContentLength: sizeBytes,
          ContentType: 'application/octet-stream',
          ChecksumSHA256: checksum,
          Metadata: {
            'dump-duration-ms': String(dumpDurationMs),
          },
        }),
      );

      await this.rotateExpiredBackups(bucket, prefix);

      const status = this.createStatus(startedAt, 'SUCCESS', {
        dumpDurationMs,
        sizeBytes,
        objectKey,
      });
      this.lastRunStatus = status;
      this.logger.log(`Database backup succeeded ${JSON.stringify(status)}`);
      return status;
    } catch (error) {
      const message = this.getErrorMessage(error);
      const status = this.createStatus(startedAt, 'FAILED', {
        dumpDurationMs,
        sizeBytes,
        objectKey,
        message,
      });
      this.lastRunStatus = status;
      this.logger.error(`Database backup failed ${JSON.stringify(status)}`);
      return status;
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          (error) =>
            this.logger.warn(
              `Failed to remove temporary backup files: ${this.getErrorMessage(error)}`,
            ),
        );
      }
      this.backupInProgress = false;
    }
  }

  getLastRunStatus(): BackupRunStatus | null {
    return this.lastRunStatus ? { ...this.lastRunStatus } : null;
  }

  private async createDump(
    connection: DatabaseConnection,
    dumpPath: string,
  ): Promise<void> {
    await this.runDatabaseCommand(
      'pg_dump',
      ['--format=custom', '--no-password', '--file', dumpPath],
      connection,
    );
  }

  private async validateDump(dumpPath: string): Promise<void> {
    await this.runDatabaseCommand('pg_restore', ['--list', dumpPath]);
  }

  private runDatabaseCommand(
    command: string,
    args: string[],
    connection?: DatabaseConnection,
  ): Promise<void> {
    const commandEnvironment = connection
      ? {
          ...process.env,
          PGHOST: connection.hostname,
          PGPORT: connection.port,
          PGUSER: connection.username,
          PGPASSWORD: connection.password,
          PGDATABASE: connection.database,
          ...(connection.sslMode ? { PGSSLMODE: connection.sslMode } : {}),
        }
      : process.env;

    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: commandEnvironment,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }

          const detail = stderr.trim() || error.message;
          reject(new Error(`${command} failed: ${detail}`));
        },
      );
    });
  }

  private async calculateChecksum(dumpPath: string): Promise<string> {
    const hash = createHash('sha256');

    for await (const chunk of createReadStream(dumpPath)) {
      hash.update(chunk);
    }

    return hash.digest('base64');
  }

  private async rotateExpiredBackups(
    bucket: string,
    prefix: string,
  ): Promise<void> {
    const retentionDays = this.getPositiveInteger('BACKUP_RETENTION_DAYS', 30);
    const expiresBefore = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    );
    let continuationToken: string | undefined;
    let deletedCount = 0;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );
      const expiredObjects = (response.Contents ?? [])
        .filter(
          (object) =>
            object.Key &&
            object.LastModified &&
            object.LastModified < expiresBefore,
        )
        .map((object) => ({ Key: object.Key as string }));

      if (expiredObjects.length > 0) {
        const deleteResponse = await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: expiredObjects,
              Quiet: true,
            },
          }),
        );
        if (deleteResponse.Errors?.length) {
          throw new Error(
            `Failed to delete ${deleteResponse.Errors.length} expired backup object(s)`,
          );
        }
        deletedCount += expiredObjects.length;
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    this.logger.log(
      `Database backup retention completed: deleted ${deletedCount} object(s) older than ${retentionDays} day(s)`,
    );
  }

  private parseDatabaseUrl(databaseUrl: string): DatabaseConnection {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(databaseUrl);
    } catch {
      throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
    }

    if (
      parsedUrl.protocol !== 'postgresql:' &&
      parsedUrl.protocol !== 'postgres:'
    ) {
      throw new Error('DATABASE_URL must use the PostgreSQL protocol');
    }

    const database = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
    if (!parsedUrl.hostname || !database) {
      throw new Error('DATABASE_URL must include a host and database name');
    }

    return {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || '5432',
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
      database,
      sslMode: parsedUrl.searchParams.get('sslmode') ?? undefined,
    };
  }

  private getRequiredConfig(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) {
      throw new Error(`${key} is required when database backups are enabled`);
    }
    return value;
  }

  private getObjectPrefix(): string {
    const configuredPrefix = this.config.get<string>(
      'BACKUP_S3_PREFIX',
      'database-backups',
    );
    const prefix = configuredPrefix.replace(/^\/+|\/+$/g, '');
    return prefix || 'database-backups';
  }

  private getPositiveInteger(key: string, fallback: number): number {
    const configuredValue = this.config.get<string | number>(key, fallback);
    const parsedValue = Number(configuredValue);

    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }

    return parsedValue;
  }

  private isBackupEnabled(): boolean {
    return (
      String(this.config.get<string | boolean>('BACKUP_ENABLED', false))
        .trim()
        .toLowerCase() === 'true'
    );
  }

  private recordSkippedRun(startedAt: Date, message: string): BackupRunStatus {
    const status = this.createStatus(startedAt, 'SKIPPED', { message });
    this.lastRunStatus = status;
    this.logger.warn(`Database backup skipped ${JSON.stringify(status)}`);
    return status;
  }

  private createStatus(
    startedAt: Date,
    state: BackupRunState,
    details: Partial<BackupRunStatus>,
  ): BackupRunStatus {
    const completedAt = new Date();
    return {
      state,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...details,
    };
  }

  private toFileTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
  }
}
