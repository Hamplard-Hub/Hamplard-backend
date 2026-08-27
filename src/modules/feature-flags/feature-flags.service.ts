import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';
import { Prisma } from '@prisma/client';

/**
 * FeatureFlagsService
 *
 * Provides:
 *  - CRUD management for feature flags (admin only)
 *  - Flag evaluation with deterministic rollout, role filtering, and user allow-list
 *  - Bulk flag evaluation for SDK-style client bootstrapping
 *
 * Rollout algorithm:
 *  A flag is enabled for a user when ALL of the following are true:
 *    1. flag.enabled === true
 *    2. Role check passes (allowedRoles empty OR user role is in the list)
 *    3. User is in the allow-list OR falls within the rollout bucket
 *       - Bucket = fnv1a(userId + key) % 100 < rolloutPercent
 *       - If no userId, bucket defaults to 0 (always in if rolloutPercent > 0)
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // CRUD
  // ----------------------------------------------------------

  async create(dto: CreateFeatureFlagDto) {
    const existing = await this.prisma.featureFlag.findUnique({
      where: { key: dto.key },
    });
    if (existing) {
      throw new ConflictException(`Feature flag "${dto.key}" already exists`);
    }

    const flag = await this.prisma.featureFlag.create({
      data: {
        key: dto.key,
        description: dto.description ?? null,
        enabled: dto.enabled ?? false,
        rolloutPercent: dto.rolloutPercent ?? 100,
        allowedRoles: dto.allowedRoles ?? [],
        allowedUserIds: dto.allowedUserIds ?? [],
        metadata: (dto.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    this.logger.log(`Feature flag created: "${flag.key}" (enabled=${flag.enabled})`);
    return flag;
  }

  async findAll() {
    return this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async findOne(key: string) {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      throw new NotFoundException(`Feature flag "${key}" not found`);
    }
    return flag;
  }

  async update(key: string, dto: UpdateFeatureFlagDto) {
    await this.findOne(key); // ensure it exists

    const flag = await this.prisma.featureFlag.update({
      where: { key },
      data: {
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.rolloutPercent !== undefined && { rolloutPercent: dto.rolloutPercent }),
        ...(dto.allowedRoles !== undefined && { allowedRoles: dto.allowedRoles }),
        ...(dto.allowedUserIds !== undefined && { allowedUserIds: dto.allowedUserIds }),
        ...(dto.metadata !== undefined && {
          metadata: dto.metadata as Prisma.InputJsonValue,
        }),
      },
    });

    this.logger.log(
      `Feature flag updated: "${flag.key}" (enabled=${flag.enabled}, rollout=${flag.rolloutPercent}%)`,
    );
    return flag;
  }

  async remove(key: string) {
    await this.findOne(key); // ensure it exists
    await this.prisma.featureFlag.delete({ where: { key } });
    this.logger.log(`Feature flag deleted: "${key}"`);
    return { message: `Feature flag "${key}" deleted` };
  }

  // ----------------------------------------------------------
  // TOGGLE SHORTCUTS
  // ----------------------------------------------------------

  async enable(key: string) {
    return this.update(key, { enabled: true });
  }

  async disable(key: string) {
    return this.update(key, { enabled: false });
  }

  // ----------------------------------------------------------
  // EVALUATION
  // ----------------------------------------------------------

  /**
   * Evaluate a single flag for a specific user context.
   * Returns { key, enabled: boolean, reason }
   */
  async evaluate(
    key: string,
    context: { userId?: string; role?: string },
  ): Promise<{ key: string; enabled: boolean; reason: string }> {
    const flag = await this.findOne(key);
    return this.evaluateFlag(flag, context);
  }

  /**
   * Bulk-evaluate all enabled flags for a user context.
   * Useful for SDK bootstrapping (returns a key→boolean map).
   */
  async evaluateAll(context: {
    userId?: string;
    role?: string;
  }): Promise<Record<string, boolean>> {
    const flags = await this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
    });

    const result: Record<string, boolean> = {};
    for (const flag of flags) {
      const { enabled } = this.evaluateFlag(flag, context);
      result[flag.key] = enabled;
    }
    return result;
  }

  /**
   * Check whether a flag is enabled for a user without throwing (safe for guards/interceptors).
   * Returns false if the flag does not exist.
   */
  async isEnabled(
    key: string,
    context: { userId?: string; role?: string } = {},
  ): Promise<boolean> {
    try {
      const { enabled } = await this.evaluate(key, context);
      return enabled;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------
  // INTERNAL — deterministic rollout
  // ----------------------------------------------------------

  private evaluateFlag(
    flag: {
      key: string;
      enabled: boolean;
      rolloutPercent: number;
      allowedRoles: string[];
      allowedUserIds: string[];
    },
    context: { userId?: string; role?: string },
  ): { key: string; enabled: boolean; reason: string } {
    if (!flag.enabled) {
      return { key: flag.key, enabled: false, reason: 'flag_disabled' };
    }

    // Role check
    if (flag.allowedRoles.length > 0) {
      if (!context.role || !flag.allowedRoles.includes(context.role)) {
        return {
          key: flag.key,
          enabled: false,
          reason: `role_not_allowed (role=${context.role ?? 'none'})`,
        };
      }
    }

    // Explicit allow-list
    if (context.userId && flag.allowedUserIds.includes(context.userId)) {
      return { key: flag.key, enabled: true, reason: 'explicit_allow_list' };
    }

    // Rollout bucket — deterministic per user+flag key
    if (flag.rolloutPercent >= 100) {
      return { key: flag.key, enabled: true, reason: 'full_rollout' };
    }

    if (flag.rolloutPercent <= 0) {
      return { key: flag.key, enabled: false, reason: 'zero_rollout' };
    }

    const bucket = this.rolloutBucket(context.userId, flag.key);
    const inBucket = bucket < flag.rolloutPercent;
    return {
      key: flag.key,
      enabled: inBucket,
      reason: inBucket
        ? `in_rollout_bucket (${bucket}/${flag.rolloutPercent})`
        : `outside_rollout_bucket (${bucket}/${flag.rolloutPercent})`,
    };
  }

  /**
   * FNV-1a 32-bit hash → value in [0, 100).
   * Deterministic: same userId+key always maps to the same bucket.
   */
  private rolloutBucket(userId: string | undefined, key: string): number {
    const input = `${userId ?? 'anonymous'}:${key}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0; // keep as unsigned 32-bit
    }
    return hash % 100;
  }
}
