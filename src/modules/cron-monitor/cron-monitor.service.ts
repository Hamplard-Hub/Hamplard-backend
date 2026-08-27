import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CronJobStatus, Prisma } from '@prisma/client';
import { QueryCronRunsDto } from './dto/query-cron-runs.dto';

export interface CronRunHandle {
  /** Call this when the job finishes successfully */
  success(message?: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Call this when the job fails */
  fail(error: unknown, metadata?: Record<string, unknown>): Promise<void>;
  /** Call this when the job was skipped (e.g. nothing to process) */
  skip(message?: string): Promise<void>;
}

/**
 * CronMonitorService
 *
 * Wraps every cron job execution in a CronJobRun database record so you can:
 *  - See the full history of every scheduled job
 *  - Spot missed or failing runs at a glance
 *  - Track average duration and last success/failure time
 *  - Alert when a job exceeds a duration threshold
 *
 * Usage in a cron service:
 *
 *   const run = await this.cronMonitor.start('my-job-name');
 *   try {
 *     // ... do work ...
 *     await run.success('Processed 42 rows', { rows: 42 });
 *   } catch (err) {
 *     await run.fail(err);
 *   }
 */
@Injectable()
export class CronMonitorService {
  private readonly logger = new Logger(CronMonitorService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // INSTRUMENTATION API
  // ----------------------------------------------------------

  /**
   * Record the start of a cron job run.
   * Returns a handle with success / fail / skip methods to close the run.
   */
  async start(jobName: string): Promise<CronRunHandle> {
    const run = await this.prisma.cronJobRun.create({
      data: { jobName, status: CronJobStatus.RUNNING },
    });
    const startedAt = run.startedAt;
    this.logger.debug(`[CronMonitor] ${jobName} started (id=${run.id})`);

    const finish = async (
      status: CronJobStatus,
      message?: string,
      error?: string,
      metadata?: Record<string, unknown>,
    ) => {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await this.prisma.cronJobRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt,
          durationMs,
          message: message ?? null,
          error: error ?? null,
          metadata: (metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });

      const logMsg = `[CronMonitor] ${jobName} ${status} in ${durationMs}ms`;
      if (status === CronJobStatus.FAILED) {
        this.logger.error(logMsg + (error ? ` — ${error}` : ''));
      } else {
        this.logger.log(logMsg);
      }
    };

    return {
      success: (message, metadata) =>
        finish(CronJobStatus.SUCCESS, message, undefined, metadata),
      fail: (err, metadata) =>
        finish(
          CronJobStatus.FAILED,
          undefined,
          err instanceof Error ? err.message : String(err),
          metadata,
        ),
      skip: (message) =>
        finish(CronJobStatus.SKIPPED, message ?? 'skipped'),
    };
  }

  /**
   * Convenience wrapper: runs an async callback and automatically records
   * success or failure. Rethrows the error after recording it.
   */
  async run<T>(
    jobName: string,
    callback: () => Promise<T>,
    options?: { skipIf?: () => boolean | Promise<boolean> },
  ): Promise<T> {
    if (options?.skipIf) {
      const shouldSkip = await options.skipIf();
      if (shouldSkip) {
        const handle = await this.start(jobName);
        await handle.skip('skipIf condition was true');
        return undefined as unknown as T;
      }
    }

    const handle = await this.start(jobName);
    try {
      const result = await callback();
      await handle.success();
      return result;
    } catch (err) {
      await handle.fail(err);
      throw err;
    }
  }

  // ----------------------------------------------------------
  // QUERY API
  // ----------------------------------------------------------

  async findAll(query: QueryCronRunsDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.CronJobRunWhereInput = {};
    if (query.jobName) where.jobName = query.jobName;
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.startedAt = {};
      if (query.from) where.startedAt.gte = new Date(query.from);
      if (query.to) where.startedAt.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.cronJobRun.findMany({
        where,
        skip,
        take: limit,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.cronJobRun.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
    };
  }

  async findOne(id: string) {
    const run = await this.prisma.cronJobRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`CronJobRun "${id}" not found`);
    return run;
  }

  /**
   * Aggregated stats per job name: last run, last success, last failure,
   * success rate, average duration over the last 30 days.
   */
  async getStats() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    const runs = await this.prisma.cronJobRun.findMany({
      where: { startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
    });

    // Group by jobName
    const grouped = new Map<
      string,
      {
        total: number;
        success: number;
        failed: number;
        skipped: number;
        running: number;
        totalDurationMs: number;
        durationCount: number;
        lastRun: Date | null;
        lastSuccess: Date | null;
        lastFailure: Date | null;
        lastError: string | null;
      }
    >();

    for (const run of runs) {
      if (!grouped.has(run.jobName)) {
        grouped.set(run.jobName, {
          total: 0,
          success: 0,
          failed: 0,
          skipped: 0,
          running: 0,
          totalDurationMs: 0,
          durationCount: 0,
          lastRun: null,
          lastSuccess: null,
          lastFailure: null,
          lastError: null,
        });
      }
      const g = grouped.get(run.jobName)!;
      g.total++;

      switch (run.status) {
        case CronJobStatus.SUCCESS: g.success++; break;
        case CronJobStatus.FAILED:  g.failed++;  break;
        case CronJobStatus.SKIPPED: g.skipped++; break;
        case CronJobStatus.RUNNING: g.running++; break;
      }

      if (run.durationMs != null) {
        g.totalDurationMs += run.durationMs;
        g.durationCount++;
      }

      if (!g.lastRun || run.startedAt > g.lastRun) g.lastRun = run.startedAt;

      if (run.status === CronJobStatus.SUCCESS) {
        if (!g.lastSuccess || run.startedAt > g.lastSuccess)
          g.lastSuccess = run.startedAt;
      }
      if (run.status === CronJobStatus.FAILED) {
        if (!g.lastFailure || run.startedAt > g.lastFailure) {
          g.lastFailure = run.startedAt;
          g.lastError = run.error;
        }
      }
    }

    return Array.from(grouped.entries())
      .map(([jobName, g]) => ({
        jobName,
        periodDays: 30,
        total: g.total,
        success: g.success,
        failed: g.failed,
        skipped: g.skipped,
        running: g.running,
        successRate:
          g.total > 0
            ? Math.round((g.success / (g.total - g.running - g.skipped)) * 100 * 10) / 10
            : null,
        avgDurationMs:
          g.durationCount > 0
            ? Math.round(g.totalDurationMs / g.durationCount)
            : null,
        lastRun: g.lastRun,
        lastSuccess: g.lastSuccess,
        lastFailure: g.lastFailure,
        lastError: g.lastError,
      }))
      .sort((a, b) => a.jobName.localeCompare(b.jobName));
  }

  /**
   * Find stale RUNNING runs (started more than `thresholdMinutes` ago).
   * These are likely zombies from a crashed process.
   */
  async findStaleRuns(thresholdMinutes = 30) {
    const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    return this.prisma.cronJobRun.findMany({
      where: {
        status: CronJobStatus.RUNNING,
        startedAt: { lt: threshold },
      },
      orderBy: { startedAt: 'asc' },
    });
  }

  /**
   * Mark stale RUNNING runs as FAILED.
   * Called by a cleanup cron job (defined inside this service).
   */
  async markStaleRunsFailed(thresholdMinutes = 30) {
    const stale = await this.findStaleRuns(thresholdMinutes);
    if (stale.length === 0) return { marked: 0 };

    const ids = stale.map((r) => r.id);
    await this.prisma.cronJobRun.updateMany({
      where: { id: { in: ids } },
      data: {
        status: CronJobStatus.FAILED,
        finishedAt: new Date(),
        error: `Marked as FAILED by stale-run cleanup (threshold: ${thresholdMinutes} min)`,
      },
    });

    this.logger.warn(
      `[CronMonitor] Marked ${stale.length} stale RUNNING run(s) as FAILED: ${ids.join(', ')}`,
    );
    return { marked: stale.length, ids };
  }

  /**
   * Purge old cron run history (keeps the last `retentionDays` days).
   */
  async purgeOldRuns(retentionDays = 90) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.cronJobRun.deleteMany({
      where: { startedAt: { lt: cutoff } },
    });
    this.logger.log(
      `[CronMonitor] Purged ${result.count} cron run records older than ${retentionDays} days`,
    );
    return { deleted: result.count };
  }
}
