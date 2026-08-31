import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LearningPathStatus, Prisma } from '@prisma/client';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';

@Injectable()
export class LearningPathsService {
  private readonly logger = new Logger(LearningPathsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  /**
   * Converts a path title into a normalised URL-safe slug used as the
   * unique identifier — same scheme as tags.
   */
  private normalise(title: string): string {
    return title
      .trim()
      .toLowerCase()
      .replace(/[&/\\]+/g, '-')
      .replace(/[\s\W]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private async findPathOrThrow(id: string) {
    const path = await this.prisma.learningPath.findUnique({
      where: { id },
      include: {
        courses: {
          orderBy: { position: 'asc' },
          include: {
            course: {
              select: {
                id: true,
                title: true,
                category: true,
                level: true,
                thumbnailUrl: true,
                status: true,
                totalLessons: true,
                price: true,
              },
            },
          },
        },
      },
    });
    if (!path) throw new NotFoundException(`Learning path ${id} not found`);
    return path;
  }

  /**
   * Validates an ordered course list for a path:
   *  - all IDs exist and refer to ACTIVE courses
   *  - no duplicates (first occurrence wins)
   *  - any prerequisite of a path course that is ALSO in the path must sit
   *    at an earlier position (issue #23: prerequisite completion order)
   */
  private async validateOrderedCourses(courseIds: string[]) {
    const uniqueIds = [...new Set(courseIds)];

    const courses = await this.prisma.course.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, title: true, status: true },
    });

    const missing = uniqueIds.filter((id) => !courses.some((c) => c.id === id));
    if (missing.length) {
      throw new NotFoundException(`Unknown course ID(s): ${missing.join(', ')}`);
    }

    const nonActive = courses.filter((c) => c.status !== 'ACTIVE');
    if (nonActive.length) {
      throw new BadRequestException(
        `Only ACTIVE courses can be added to a path. Rejected: ${nonActive
          .map((c) => `"${c.title}" (${c.id}, ${c.status})`)
          .join(', ')}`,
      );
    }

    const positionOf = new Map(uniqueIds.map((id, i) => [id, i]));
    const rows = await this.prisma.coursePrerequisite.findMany({
      where: { courseId: { in: uniqueIds }, prerequisiteId: { in: uniqueIds } },
      select: { courseId: true, prerequisiteId: true },
    });

    const violations = rows.filter(
      (r) => (positionOf.get(r.prerequisiteId) ?? 0) > (positionOf.get(r.courseId) ?? 0),
    );
    if (violations.length) {
      const detail = violations
        .map((v) => `course ${v.prerequisiteId} must come before ${v.courseId}`)
        .join('; ');
      throw new BadRequestException(
        `Prerequisite order violated inside the path: ${detail}`,
      );
    }

    return uniqueIds;
  }

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  async create(adminId: string, dto: CreatePathDto) {
    const slug = this.normalise(dto.title);

    const conflict = await this.prisma.learningPath.findUnique({ where: { slug } });
    if (conflict) {
      throw new ConflictException(
        `A learning path titled "${conflict.title}" already exists (slug: "${slug}")`,
      );
    }

    let initialCourses: string[] = [];
    if (dto.courseIds?.length) {
      initialCourses = await this.validateOrderedCourses(dto.courseIds);
    }

    const path = await this.prisma.$transaction(async (tx) => {
      const created = await tx.learningPath.create({
        data: {
          title: dto.title.trim(),
          slug,
          description: dto.description,
          thumbnailUrl: dto.thumbnailUrl,
          createdById: adminId,
        },
      });

      if (initialCourses.length) {
        await tx.learningPathCourse.createMany({
          data: initialCourses.map((courseId, position) => ({
            pathId: created.id,
            courseId,
            position,
          })),
        });
      }

      return created;
    });

    this.logger.log(`Learning path created: "${path.title}" (${path.id}) by ${adminId}`);
    return this.findOne(path.id);
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  /**
   * Paginated listing. Students see PUBLISHED paths only; admins see all
   * statuses (optionally filtered by ?status=).
   */
  async findAll(
    query: { page?: number; limit?: number; search?: string; status?: LearningPathStatus },
    isAdmin: boolean,
  ) {
    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const skip = (page - 1) * limit;

    const where: Prisma.LearningPathWhereInput = {};
    if (!isAdmin) {
      where.status = LearningPathStatus.PUBLISHED;
    } else if (query.status) {
      where.status = query.status;
    }
    if (query.search) {
      where.title = { contains: query.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.learningPath.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: limit,
        include: { _count: { select: { courses: true } } },
      }),
      this.prisma.learningPath.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    return this.findPathOrThrow(id);
  }

  // ----------------------------------------------------------
  // UPDATE
  // ----------------------------------------------------------

  async update(id: string, dto: UpdatePathDto) {
    const path = await this.findPathOrThrow(id);

    let slug = path.slug;
    if (dto.title && dto.title.trim() !== path.title) {
      slug = this.normalise(dto.title);
      if (slug !== path.slug) {
        const conflict = await this.prisma.learningPath.findUnique({ where: { slug } });
        if (conflict) {
          throw new ConflictException(
            `A learning path titled "${conflict.title}" already exists (slug: "${slug}")`,
          );
        }
      }
    }

    const updated = await this.prisma.learningPath.update({
      where: { id },
      data: {
        ...(dto.title ? { title: dto.title.trim(), slug } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.thumbnailUrl !== undefined ? { thumbnailUrl: dto.thumbnailUrl } : {}),
      },
    });

    this.logger.log(`Learning path updated: ${updated.id}`);
    return updated;
  }

  // ----------------------------------------------------------
  // COURSE ORDERING — full replacement (curriculum builder)
  // ----------------------------------------------------------

  async replaceCourses(pathId: string, courseIds: string[]) {
    const path = await this.findPathOrThrow(pathId);
    if (path.status === LearningPathStatus.ARCHIVED) {
      throw new BadRequestException('Cannot modify an ARCHIVED learning path');
    }
    if (path.status === LearningPathStatus.PUBLISHED && courseIds.length < 2) {
      throw new BadRequestException('A published learning path needs at least 2 courses');
    }

    const uniqueIds = await this.validateOrderedCourses(courseIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.learningPathCourse.deleteMany({ where: { pathId } });
      await tx.learningPathCourse.createMany({
        data: uniqueIds.map((courseId, position) => ({ pathId, courseId, position })),
      });
    });

    this.logger.log(`Learning path ${pathId} curriculum replaced (${uniqueIds.length} courses)`);
    return this.findOne(pathId);
  }

  // ----------------------------------------------------------
  // PUBLISHING STATUS
  // ----------------------------------------------------------

  async publish(id: string) {
    const path = await this.findPathOrThrow(id);
    if (path.status === LearningPathStatus.PUBLISHED) {
      throw new BadRequestException('Learning path is already published');
    }
    if (path.courses.length < 2) {
      throw new BadRequestException(
        'A learning path needs at least 2 courses before it can be published',
      );
    }

    // Re-check the positional invariant against current prerequisites —
    // admins may have added new prerequisite edges after the last edit.
    await this.validateOrderedCourses(path.courses.map((pc) => pc.courseId));

    const published = await this.prisma.learningPath.update({
      where: { id },
      data: { status: LearningPathStatus.PUBLISHED, publishedAt: new Date() },
    });

    this.logger.log(`Learning path published: ${id}`);
    return published;
  }

  async unpublish(id: string) {
    const path = await this.findPathOrThrow(id);
    if (path.status !== LearningPathStatus.PUBLISHED) {
      throw new BadRequestException('Only PUBLISHED paths can be unpublished');
    }
    return this.prisma.learningPath.update({
      where: { id },
      data: { status: LearningPathStatus.DRAFT, publishedAt: null },
    });
  }

  // ----------------------------------------------------------
  // DELETE / ARCHIVE
  // ----------------------------------------------------------

  async remove(id: string) {
    const path = await this.findPathOrThrow(id);
    await this.prisma.learningPath.delete({ where: { id } });
    this.logger.log(`Learning path deleted: "${path.title}" (${id})`);
    return { message: `Learning path "${path.title}" deleted successfully` };
  }

  // ----------------------------------------------------------
  // STUDENT PROGRESS ACROSS THE PATH
  // ----------------------------------------------------------

  /**
   * Per-course status for one student across a published path:
   * enrollment state, per-course %, whether prerequisites are satisfied,
   * plus aggregate stats and the next course they can take.
   */
  async getPathProgress(pathId: string, studentId: string) {
    const path = await this.findPathOrThrow(pathId);
    if (
      path.status !== LearningPathStatus.PUBLISHED &&
      path.createdById !== studentId
    ) {
      throw new NotFoundException(`Learning path ${pathId} not found`);
    }
    if (!path.courses.length) {
      throw new BadRequestException('This learning path has no courses yet');
    }

    const courseIds = path.courses.map((pc) => pc.courseId);

    const [enrollments, prereqRows] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { studentId, courseId: { in: courseIds } },
        select: {
          courseId: true,
          status: true,
          progressPercent: true,
          enrolledAt: true,
          completedAt: true,
        },
      }),
      this.prisma.coursePrerequisite.findMany({
        where: { courseId: { in: courseIds } },
        select: { courseId: true, prerequisiteId: true },
      }),
    ]);

    const byCourse = new Map(enrollments.map((e) => [e.courseId, e]));
    const completedCourseIds = new Set(
      enrollments.filter((e) => e.status === 'COMPLETED').map((e) => e.courseId),
    );

    let nextAvailableCourseId: string | null = null;

    const courses = path.courses.map((pc, index) => {
      const enrollment = byCourse.get(pc.courseId) ?? null;

      const pendingPrereqIds = prereqRows
        .filter((r) => r.courseId === pc.courseId)
        .map((r) => r.prerequisiteId);
      const missingPrerequisiteIds = pendingPrereqIds.filter(
        (pid) => !completedCourseIds.has(pid),
      );

      // Positional fallback: the first not-completed course in path order
      // becomes "next" once every earlier step is done or skipped-over is
      // impossible (enrollment gate enforces sequence).
      const earlierIncomplete = path.courses
        .slice(0, index)
        .some((prev) => !completedCourseIds.has(prev.courseId));

      const available =
        missingPrerequisiteIds.length === 0 && !earlierIncomplete && !enrollment;
      if (available && nextAvailableCourseId === null) {
        nextAvailableCourseId = pc.courseId;
      }

      return {
        courseId: pc.courseId,
        title: pc.course.title,
        thumbnailUrl: pc.course.thumbnailUrl,
        position: pc.position,
        enrolled: !!enrollment,
        enrollmentStatus: enrollment?.status ?? null,
        progressPercent: enrollment?.progressPercent ?? 0,
        completed: enrollment?.status === 'COMPLETED',
        missingPrerequisiteIds,
      };
    });

    // Fallback: strictly-prerequisite-gated "available" only applies before
    // first enrollment — mid-path students should still see their next step.
    let finalNextCourseId = nextAvailableCourseId;
    if (!finalNextCourseId) {
      const firstUnfinished = courses.find((c) => !c.completed);
      finalNextCourseId = firstUnfinished?.courseId ?? null;
    }

    const completedCount = courses.filter((c) => c.completed).length;

    return {
      path: {
        id: path.id,
        title: path.title,
        slug: path.slug,
        description: path.description,
        thumbnailUrl: path.thumbnailUrl,
        status: path.status,
      },
      summary: {
        totalCourses: courses.length,
        completedCount,
        percentComplete: Math.round((completedCount / courses.length) * 100),
        enrolledCount: courses.filter((c) => c.enrolled).length,
        nextAvailableCourseId: finalNextCourseId,
      },
      courses,
    };
  }
}
