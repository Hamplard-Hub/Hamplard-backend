import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DbBackupService } from './db-backup.service';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

describe('DbBackupService', () => {
  let service: DbBackupService;
  let configValues: Record<string, string | boolean | number>;
  let send: jest.Mock;
  const mockedExecFile = execFile as unknown as jest.Mock;

  beforeEach(() => {
    configValues = {
      BACKUP_ENABLED: true,
      BACKUP_S3_BUCKET: 'backup-bucket',
      BACKUP_S3_PREFIX: '/nightly/',
      BACKUP_RETENTION_DAYS: 7,
      DATABASE_URL:
        'postgresql://backup-user:secret@database.internal:5433/hamplard?sslmode=require',
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in configValues ? configValues[key] : fallback,
      ),
    } as unknown as ConfigService;
    send = jest.fn();
    service = new DbBackupService(config, { send } as unknown as S3Client);
    mockedExecFile.mockReset();
  });

  it('creates, validates, uploads, and rotates a backup with status metrics', async () => {
    mockedExecFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command === 'pg_dump') {
          const dumpPath = args[args.indexOf('--file') + 1];
          writeFileSync(dumpPath, 'valid-dump');
        }
        callback(null, command === 'pg_restore' ? 'archive contents' : '', '');
      },
    );

    let listPage = 0;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        for await (const _chunk of command.input.Body as Readable) {
          // Consume the stream before the temporary file is removed.
        }
        return {};
      }

      if (command instanceof ListObjectsV2Command) {
        listPage += 1;
        return listPage === 1
          ? {
              Contents: [
                {
                  Key: 'nightly/expired.dump',
                  LastModified: new Date('2000-01-01T00:00:00.000Z'),
                },
              ],
              IsTruncated: true,
              NextContinuationToken: 'next-page',
            }
          : {
              Contents: [
                {
                  Key: 'nightly/current.dump',
                  LastModified: new Date(Date.now() + 60_000),
                },
              ],
              IsTruncated: false,
            };
      }

      return {};
    });

    const result = await service.runBackup();

    expect(result).toEqual(
      expect.objectContaining({
        state: 'SUCCESS',
        dumpDurationMs: expect.any(Number),
        durationMs: expect.any(Number),
        sizeBytes: 10,
        objectKey: expect.stringMatching(/^nightly\/hamplard-.*\.dump$/),
      }),
    );
    expect(service.getLastRunStatus()).toEqual(result);

    const dumpCall = mockedExecFile.mock.calls[0];
    expect(dumpCall[0]).toBe('pg_dump');
    expect(dumpCall[1]).toEqual([
      '--format=custom',
      '--no-password',
      '--file',
      expect.any(String),
    ]);
    expect(dumpCall[1].join(' ')).not.toContain('secret');
    expect(dumpCall[2].env).toEqual(
      expect.objectContaining({
        PGHOST: 'database.internal',
        PGPORT: '5433',
        PGUSER: 'backup-user',
        PGPASSWORD: 'secret',
        PGDATABASE: 'hamplard',
        PGSSLMODE: 'require',
      }),
    );
    expect(mockedExecFile.mock.calls[1][0]).toBe('pg_restore');
    expect(mockedExecFile.mock.calls[1][1][0]).toBe('--list');

    const putCommand = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutObjectCommand);
    expect(putCommand.input).toEqual(
      expect.objectContaining({
        Bucket: 'backup-bucket',
        ContentLength: 10,
        ChecksumSHA256: createHash('sha256')
          .update('valid-dump')
          .digest('base64'),
      }),
    );

    const listCommands = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof ListObjectsV2Command);
    expect(listCommands).toHaveLength(2);
    expect(listCommands[1].input.ContinuationToken).toBe('next-page');

    const deleteCommand = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof DeleteObjectsCommand);
    expect(deleteCommand.input.Delete.Objects).toEqual([
      { Key: 'nightly/expired.dump' },
    ]);
  });

  it('does not upload a dump that fails integrity validation', async () => {
    mockedExecFile.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (command === 'pg_dump') {
          writeFileSync(args[args.indexOf('--file') + 1], 'invalid-dump');
          callback(null, '', '');
          return;
        }
        callback(new Error('invalid archive'), '', 'invalid archive');
      },
    );

    const result = await service.runBackup();

    expect(result).toEqual(
      expect.objectContaining({
        state: 'FAILED',
        message: 'pg_restore failed: invalid archive',
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('skips execution when backups are disabled', async () => {
    configValues.BACKUP_ENABLED = false;

    const result = await service.runBackup();

    expect(result.state).toBe('SKIPPED');
    expect(result.message).toBe('Database backups are disabled');
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('delegates scheduled runs to the backup runner', async () => {
    const expected = {
      state: 'SKIPPED' as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
    };
    jest.spyOn(service, 'runBackup').mockResolvedValue(expected);

    await expect(service.handleScheduledBackup()).resolves.toEqual(expected);
    expect(service.runBackup).toHaveBeenCalledTimes(1);
  });
});
