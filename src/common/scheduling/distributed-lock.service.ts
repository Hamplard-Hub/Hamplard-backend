import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';

/**
 * Distributed Lock Service (issue #310)
 *
 * Provides a lightweight distributed locking mechanism using Redis SET NX PX.
 * Prevents duplicate cron jobs from running across multiple API instances.
 *
 * Usage:
 *  - Use acquireLock() for fine-grained control (acquire, check error, release)
 *  - Use withLock() helper for automatic acquire/release within an async function
 *
 * Example:
 *  const acquired = await lockService.acquireLock('my-cron-job', 30000); // 30s TTL
 *  if (!acquired) return; // Another instance is running this job
 *  try {
 *    await doWork();
 *  } finally {
 *    await lockService.releaseLock('my-cron-job');
 *  }
 *
 * Or:
 *  await lockService.withLock('my-cron-job', 30000, async () => {
 *    await doWork();
 *  });
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly lockKeyPrefix = 'hamplard:lock:';
  private readonly lockValuePrefix = 'instance:';

  constructor(
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Acquire a distributed lock.
   * 
   * @param lockName   Unique identifier for the lock (e.g., 'audit-log-cleanup')
   * @param ttlMs      Time-to-live in milliseconds. Lock auto-releases if not explicitly released.
   * @returns true if lock was acquired, false if another instance holds it
   */
  async acquireLock(lockName: string, ttlMs: number): Promise<boolean> {
    if (!lockName || lockName.length === 0) {
      throw new Error('Lock name cannot be empty');
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('TTL must be a positive integer (milliseconds)');
    }

    const key = `${this.lockKeyPrefix}${lockName}`;
    const value = `${this.lockValuePrefix}${process.pid}-${Date.now()}`;

    try {
      // Redis SET NX PX: set key only if it doesn't exist, with TTL
      const result = await this.redis.set(key, value, 'NX', 'PX', ttlMs);
      const acquired = result === 'OK';

      if (acquired) {
        this.logger.debug(`Lock acquired: ${lockName} (TTL: ${ttlMs}ms)`);
      } else {
        this.logger.debug(`Lock already held: ${lockName}`);
      }

      return acquired;
    } catch (error) {
      this.logger.error(`Failed to acquire lock ${lockName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Release a distributed lock.
   * 
   * @param lockName   The same identifier used in acquireLock()
   * @returns true if lock was released, false if not held or already expired
   */
  async releaseLock(lockName: string): Promise<void> {
    if (!lockName || lockName.length === 0) {
      throw new Error('Lock name cannot be empty');
    }

    const key = `${this.lockKeyPrefix}${lockName}`;

    try {
      // Use DEL to remove the lock key
      const result = await this.redis.del(key);
      if (result > 0) {
        this.logger.debug(`Lock released: ${lockName}`);
      } else {
        this.logger.debug(`Lock not held or already expired: ${lockName}`);
      }
    } catch (error) {
      this.logger.error(`Failed to release lock ${lockName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Helper to acquire lock, run a function, and automatically release.
   * 
   * @param lockName  Unique identifier for the lock
   * @param ttlMs     Time-to-live in milliseconds
   * @param fn        Async function to execute while holding the lock
   * @returns The return value of fn, or null if lock was not acquired
   * 
   * If lock is not acquired (another instance holds it), fn is not called
   * and null is returned.
   */
  async withLock<T>(
    lockName: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const acquired = await this.acquireLock(lockName, ttlMs);
    if (!acquired) {
      this.logger.debug(`Skipping locked task: ${lockName}`);
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.releaseLock(lockName);
    }
  }

  /**
   * Health check: verify Redis connectivity.
   * Called during module init to ensure Redis is available.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch (error) {
      this.logger.error(`Redis healthcheck failed: ${error.message}`);
      return false;
    }
  }
}
