import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditTargetType } from '@prisma/client';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { MergeTagsDto } from './dto/merge-tags.dto';
import { AttachTagDto } from './dto/attach-tag.dto';
import { QueryTagsDto } from './dto/query-tags.dto';

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  /**
   * Converts a human-readable label into a normalised, URL-safe slug used as
   * the unique `name` field.
   *
   * "Web Design"  →  "web-design"
   * "UI/UX & Branding" → "ui-ux-branding"
   */
  private normalise(label: string): string {
    return label
      .trim()
      .toLowerCase()
      // replace ampersands and slashes with a hyphen
      .replace(/[&/\\]+/g, '-')
      // replace any run of whitespace or non-alphanumeric chars with a hyphen
      .replace(/[\s\W]+/g, '-')
      // collapse multiple consecutive hyphens
      .replace(/-{2,}/g, '-')
      // strip leading / trailing hyphens
      .replace(/^-+|-+$/g, '');
  }

  /** Throws NotFoundException if the tag does not exist. */
  private async findTagOrThrow(id: string) {
    const tag = await this.prisma.tag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    return tag;
  }

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  /**
   * Admin creates a new searchable tag.
   * The `name` (slug) is derived automatically from the `label`.
   * Duplicate detection is case-insensitive via the normalised slug.
   */
  async create(adminId: string, dto: CreateTagDto) {
    const name = this.normalise(dto.label);

    const existing = await this.prisma.tag.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictException(
        `A tag with label "${existing.label}" already exists (slug: "${name}")`,
      );
    }

    const tag = await this.prisma.tag.create({
      data: { name, label: dto.label.trim() },
    });

    await this.auditLog.createEntry(adminId, {
      action: AuditAction.TAG_CREATED,
      targetType: AuditTargetType.TAG,
      targetId: tag.id,
      metadata: { name: tag.name, label: tag.label },
    });

    this.logger.log(`Tag created: "${tag.label}" (${tag.id}) by admin ${adminId}`);
    return tag;
  }

  // ----------------------------------------------------------
  // READ — list sorted by popularity
  // ----------------------------------------------------------

  /**
   * Returns a paginated list of tags, sorted by usageCount descending
   * (most popular first).  Supports an optional label search filter.
   */
  async findAll(query: QueryTagsDto) {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.label = { contains: query.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.tag.findMany({
        where,
        orderBy: [
          { usageCount: 'desc' },
          { label: 'asc' },       // stable secondary sort
        ],
        skip,
        take: limit,
        include: {
          _count: { select: { courses: true } },
        },
      }),
      this.prisma.tag.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ----------------------------------------------------------
  // READ — single tag
  // ----------------------------------------------------------

  async findOne(id: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id },
      include: {
        _count: { select: { courses: true } },
        courses: {
          include: {
            course: {
              select: { id: true, title: true, status: true, thumbnailUrl: true },
            },
          },
        },
      },
    });
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    return tag;
  }

  // ----------------------------------------------------------
  // UPDATE
  // ----------------------------------------------------------

  /**
   * Admin updates a tag's display label.
   * The normalised slug is regenerated from the new label.
   */
  async update(id: string, adminId: string, dto: UpdateTagDto) {
    const tag = await this.findTagOrThrow(id);

    if (!dto.label) return tag; // nothing to change

    const newName = this.normalise(dto.label);

    // Check for a slug collision with a *different* tag
    if (newName !== tag.name) {
      const conflict = await this.prisma.tag.findUnique({ where: { name: newName } });
      if (conflict) {
        throw new ConflictException(
          `A tag with label "${conflict.label}" already exists (slug: "${newName}")`,
        );
      }
    }

    const updated = await this.prisma.tag.update({
      where: { id },
      data: { name: newName, label: dto.label.trim() },
    });

    await this.auditLog.createEntry(adminId, {
      action: AuditAction.TAG_UPDATED,
      targetType: AuditTargetType.TAG,
      targetId: id,
      metadata: {
        oldName: tag.name,
        oldLabel: tag.label,
        newName: updated.name,
        newLabel: updated.label,
      },
    });

    this.logger.log(`Tag updated: ${id} → "${updated.label}" by admin ${adminId}`);
    return updated;
  }

  // ----------------------------------------------------------
  // DELETE
  // ----------------------------------------------------------

  /**
   * Admin deletes a tag.
   * All CourseTag join records are removed via the CASCADE constraint defined
   * in the migration, and each affected course's usageCount is already
   * represented by the DB cascade — no manual decrement needed.
   */
  async remove(id: string, adminId: string) {
    const tag = await this.findTagOrThrow(id);

    await this.prisma.tag.delete({ where: { id } });

    await this.auditLog.createEntry(adminId, {
      action: AuditAction.TAG_DELETED,
      targetType: AuditTargetType.TAG,
      targetId: id,
      metadata: { name: tag.name, label: tag.label, usageCount: tag.usageCount },
    });

    this.logger.log(`Tag deleted: "${tag.label}" (${id}) by admin ${adminId}`);
    return { message: `Tag "${tag.label}" deleted successfully` };
  }

  // ----------------------------------------------------------
  // MERGE DUPLICATE TAGS
  // ----------------------------------------------------------

  /**
   * Merges one or more source tags into a single target tag.
   *
   * Steps:
   *  1. Verify the target and all source tags exist.
   *  2. For every source tag, move its CourseTag associations to the target
   *     (skipping any course already associated with the target to avoid
   *     unique-constraint violations).
   *  3. Delete the now-empty source tags.
   *  4. Recalculate the target's usageCount from the live join-table count.
   */
  async merge(targetTagId: string, adminId: string, dto: MergeTagsDto) {
    const { sourceTagIds } = dto;

    if (sourceTagIds.includes(targetTagId)) {
      throw new BadRequestException('Target tag ID must not appear in sourceTagIds');
    }

    // 1. Verify all tags exist
    const targetTag = await this.findTagOrThrow(targetTagId);
    await Promise.all(sourceTagIds.map((id) => this.findTagOrThrow(id)));

    // 2. Move course associations in a single transaction
    await this.prisma.$transaction(async (tx) => {
      for (const sourceId of sourceTagIds) {
        // Fetch all course links from this source tag
        const sourceLinks = await tx.courseTag.findMany({
          where: { tagId: sourceId },
          select: { courseId: true },
        });

        for (const { courseId } of sourceLinks) {
          // Only create the link if the target isn't already attached
          const alreadyLinked = await tx.courseTag.findUnique({
            where: { courseId_tagId: { courseId, tagId: targetTagId } },
          });

          if (!alreadyLinked) {
            await tx.courseTag.create({
              data: { courseId, tagId: targetTagId },
            });
          }
        }

        // Delete the source tag (CASCADE removes its CourseTag rows)
        await tx.tag.delete({ where: { id: sourceId } });
      }

      // 3. Recalculate usageCount for the target from the actual join-table rows
      const liveCount = await tx.courseTag.count({ where: { tagId: targetTagId } });
      await tx.tag.update({
        where: { id: targetTagId },
        data: { usageCount: liveCount },
      });
    });

    const merged = await this.findOne(targetTagId);

    await this.auditLog.createEntry(adminId, {
      action: AuditAction.TAG_MERGED,
      targetType: AuditTargetType.TAG,
      targetId: targetTagId,
      metadata: {
        targetLabel: targetTag.label,
        sourceTagIds,
        newUsageCount: merged.usageCount,
      },
    });

    this.logger.log(
      `Tags merged into "${targetTag.label}" (${targetTagId}): [${sourceTagIds.join(', ')}] by admin ${adminId}`,
    );

    return merged;
  }

  // ----------------------------------------------------------
  // ATTACH TAG TO COURSE
  // ----------------------------------------------------------

  /**
   * Links an existing tag to a course and increments usageCount.
   * Idempotent — re-attaching the same tag returns the existing link.
   */
  async attachToCourse(tagId: string, adminId: string, dto: AttachTagDto) {
    await this.findTagOrThrow(tagId);

    // Verify the course exists
    const course = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
    if (!course) throw new NotFoundException(`Course ${dto.courseId} not found`);

    // Upsert to keep the operation idempotent
    const existing = await this.prisma.courseTag.findUnique({
      where: { courseId_tagId: { courseId: dto.courseId, tagId } },
    });

    if (existing) {
      return { message: 'Tag is already attached to this course', courseTag: existing };
    }

    const [courseTag] = await this.prisma.$transaction([
      this.prisma.courseTag.create({ data: { courseId: dto.courseId, tagId } }),
      this.prisma.tag.update({
        where: { id: tagId },
        data: { usageCount: { increment: 1 } },
      }),
    ]);

    this.logger.log(`Tag ${tagId} attached to course ${dto.courseId} by admin ${adminId}`);
    return { message: 'Tag attached successfully', courseTag };
  }

  // ----------------------------------------------------------
  // DETACH TAG FROM COURSE
  // ----------------------------------------------------------

  /**
   * Removes the link between a tag and a course, and decrements usageCount
   * (floor at 0 to guard against any edge-case drift).
   */
  async detachFromCourse(tagId: string, courseId: string, adminId: string) {
    await this.findTagOrThrow(tagId);

    const link = await this.prisma.courseTag.findUnique({
      where: { courseId_tagId: { courseId, tagId } },
    });
    if (!link) {
      throw new NotFoundException(`Tag ${tagId} is not attached to course ${courseId}`);
    }

    await this.prisma.$transaction([
      this.prisma.courseTag.delete({
        where: { courseId_tagId: { courseId, tagId } },
      }),
      // Decrement but never go below 0
      this.prisma.$executeRaw`
        UPDATE "tags"
        SET "usageCount" = GREATEST("usageCount" - 1, 0)
        WHERE "id" = ${tagId}
      `,
    ]);

    this.logger.log(`Tag ${tagId} detached from course ${courseId} by admin ${adminId}`);
    return { message: 'Tag detached successfully' };
  }

  // ----------------------------------------------------------
  // TAGS FOR A COURSE
  // ----------------------------------------------------------

  /** Returns all tags currently attached to a given course. */
  async findByCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    const links = await this.prisma.courseTag.findMany({
      where: { courseId },
      include: { tag: true },
      orderBy: { tag: { usageCount: 'desc' } },
    });

    return links.map((l) => l.tag);
  }
}
