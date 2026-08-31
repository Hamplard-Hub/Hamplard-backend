import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FeeCalculatorService } from '../billing/fee-calculator.service';
import { CacheService } from '../../common/cache/cache.service';
import { CourseStatus, NotificationType } from '@prisma/client';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { SetPrerequisitesDto } from './dto/set-prerequisites.dto';

@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly feeCalculator: FeeCalculatorService,
    private readonly cache: CacheService,
  ) {}

  /** Issue #92 — invalidate cached course listings/categories on content updates. */
  private async invalidateCourseCaches(): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace('courses:list'),
      this.cache.invalidateNamespace('courses:categories'),
    ]);
  }

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  /**
   * Instructor creates a course draft in the backend DB.
   * The course starts as DRAFT until the instructor submits it for review.
   * On submission, status becomes PENDING and admin is notified.
   */
  async create(instructorId: string, instructorAddress: string, dto: CreateCourseDto) {
    const existing = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
    if (existing) throw new ConflictException(`Course ID ${dto.courseId} already exists`);

    const course = await this.prisma.course.create({
      data: {
        id:                 dto.courseId,
        instructorAddress,
        title:              dto.title,
        description:        dto.description,
        category:           dto.category,
        level:              dto.level ?? 'Beginner',
        language:           dto.language ?? 'English',
        thumbnailUrl:       dto.thumbnailUrl,
        previewVideoUrl:    dto.previewVideoUrl,
        price:              dto.price,
        platformFeePercent: dto.platformFeePercent ?? 20,
        status:             CourseStatus.DRAFT,
      },
    });

    this.logger.log(`Course created (draft): ${course.id} by ${instructorAddress}`);
    await this.invalidateCourseCaches();
    return course;
  }

  // ----------------------------------------------------------
  // SUBMIT FOR REVIEW
  // ----------------------------------------------------------

  /**
   * Instructor submits a DRAFT course for admin review → PENDING.
   * Called after the instructor has also registered the course on-chain.
   */
  async submitForReview(courseId: string, instructorId: string, txHash?: string) {
    const course = await this.findOne(courseId);

    if (course.status !== CourseStatus.DRAFT) {
      throw new ForbiddenException('Only DRAFT courses can be submitted for review');
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status: CourseStatus.PENDING, txHash: txHash ?? course.txHash },
    });

    // Notify all admins (simplified — notify the single admin address)
    this.logger.log(`Course ${courseId} submitted for review`);
    return updated;
  }

  // ----------------------------------------------------------
  // APPROVE / REJECT (admin)
  // ----------------------------------------------------------

  async approve(courseId: string, adminId: string) {
    const course = await this.findOne(courseId);
    if (course.status !== CourseStatus.PENDING) {
      throw new ForbiddenException('Only PENDING courses can be approved');
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status: CourseStatus.ACTIVE, approvedAt: new Date() },
    });

    // Notify instructor
    const instructor = await this.prisma.user.findUnique({
      where: { stellarAddress: course.instructorAddress },
    });
    if (instructor) {
      await this.notifications.notifyUser(
        instructor.id,
        NotificationType.COURSE_APPROVED,
        'Your course has been approved!',
        `"${course.title}" is now live on Hamplard. Students can start enrolling.`,
        { courseId },
      );
    }

    this.logger.log(`Course approved: ${courseId}`);
    await this.invalidateCourseCaches();
    return updated;
  }

  async reject(courseId: string, adminId: string, reason: string) {
    const course = await this.findOne(courseId);
    if (course.status !== CourseStatus.PENDING) {
      throw new ForbiddenException('Only PENDING courses can be rejected');
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status: CourseStatus.DRAFT },
    });

    const instructor = await this.prisma.user.findUnique({
      where: { stellarAddress: course.instructorAddress },
    });
    if (instructor) {
      await this.notifications.notifyUser(
        instructor.id,
        NotificationType.COURSE_REJECTED,
        'Course review feedback',
        `Your course "${course.title}" needs some changes before approval. Reason: ${reason}`,
        { courseId, reason },
      );
    }

    await this.invalidateCourseCaches();
    return updated;
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(filters: {
    category?: string;
    level?: string;
    status?: CourseStatus;
    instructorAddress?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const { category, level, status, instructorAddress, search, page = 1, limit = 20 } = filters;

    const where: any = {};
    if (category)          where.category = category;
    if (level)             where.level = level;
    if (status)            where.status = status;
    if (instructorAddress) where.instructorAddress = instructorAddress;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [courses, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        include: {
          instructor: { select: { name: true, stellarAddress: true, avatarUrl: true } },
          _count:     { select: { enrollments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { data: courses, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        instructor: { select: { name: true, stellarAddress: true, avatarUrl: true, bio: true } },
        modules: {
          orderBy: { position: 'asc' },
          include: {
            lessons: { orderBy: { position: 'asc' } },
          },
        },
        _count: { select: { enrollments: true } },
      },
    });
    if (!course) throw new NotFoundException(`Course ${id} not found`);
    return course;
  }

  async getCategories() {
    const categories = await this.prisma.course.groupBy({
      by: ['category'],
      where: { status: CourseStatus.ACTIVE },
      _count: { category: true },
      orderBy: { _count: { category: 'desc' } },
    });
    return categories.map((c) => ({ name: c.category, count: c._count.category }));
  }

  async update(courseId: string, instructorId: string, dto: UpdateCourseDto) {
    const course = await this.findOne(courseId);
    if (course.status === CourseStatus.ARCHIVED) {
      throw new ForbiddenException('Cannot update an archived course');
    }
    const updated = await this.prisma.course.update({ where: { id: courseId }, data: dto });
    await this.invalidateCourseCaches();
    return updated;
  }

  // ----------------------------------------------------------
  // CHECKOUT
  // ----------------------------------------------------------

  /** Computes the platform fee + regional tax breakdown for checkout. */
  async getCheckoutBreakdown(courseId: string, region?: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, title: true, price: true, platformFeePercent: true },
    });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    return {
      courseId: course.id,
      courseTitle: course.title,
      ...this.feeCalculator.computeBreakdown({
        coursePrice: Number(course.price),
        platformFeePercent: course.platformFeePercent,
        region,
      }),
    };
  }

  async updateStats(courseId: string, delta: { enrollments?: number; revenue?: number }) {
    const course = await this.findOne(courseId);
    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        totalEnrollments: { increment: delta.enrollments ?? 0 },
        totalRevenue:     { increment: delta.revenue ?? 0 },
      },
    });
  }

  // ----------------------------------------------------------
  // COURSE PREREQUISITES (issue #24)
  // ----------------------------------------------------------

  /**
   * Lists the prerequisites configured for a course — public read used by
   * the catalog and by the enrollment pre-check feedback endpoint.
   */
  async getPrerequisites(courseId: string) {
    await this.findOne(courseId);
    const rows = await this.prisma.coursePrerequisite.findMany({
      where: { courseId },
      orderBy: { prerequisiteId: 'asc' },
      include: {
        prerequisite: {
          select: {
            id: true, title: true, category: true, level: true,
            thumbnailUrl: true, status: true, totalLessons: true,
          },
        },
      },
    });
    return rows.map((r) => r.prerequisite);
  }

  /**
   * Replaces the full prerequisite list of a course (PUT semantics).
   * Guards against self-reference, unknown IDs and cycles so that multiple
   * chains can coexist while the overall graph stays acyclic.
   */
  async setPrerequisites(courseId: string, dto: SetPrerequisitesDto) {
    await this.findOne(courseId);

    const uniqueIds = [...new Set(dto.prerequisiteIds)];
    if (uniqueIds.includes(courseId)) {
      throw new ConflictException('A course cannot be its own prerequisite');
    }

    if (uniqueIds.length) {
      const courses = await this.prisma.course.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, title: true },
      });
      const missing = uniqueIds.filter((id) => !courses.some((c) => c.id === id));
      if (missing.length) {
        throw new NotFoundException(`Unknown prerequisite course ID(s): ${missing.join(', ')}`);
      }
    }

    // Simulate the FULL edge set after the replacement.
    const existing = await this.prisma.coursePrerequisite.findMany({
      select: { courseId: true, prerequisiteId: true },
    });
    const finalEdges = [
      ...existing.filter((e) => e.courseId !== courseId),
      ...uniqueIds.map((prerequisiteId) => ({ courseId, prerequisiteId })),
    ];

    const cycle = this.findCycle(finalEdges);
    if (cycle) {
      throw new ConflictException(
        `Setting these prerequisites would create a circular chain: ${cycle.join(' → ')}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.coursePrerequisite.deleteMany({ where: { courseId } });
      if (uniqueIds.length) {
        await tx.coursePrerequisite.createMany({
          data: uniqueIds.map((prerequisiteId) => ({ courseId, prerequisiteId })),
        });
      }
    });

    this.logger.log(
      `Prerequisites for course ${courseId} replaced: [${uniqueIds.join(', ') || 'none'}]`,
    );
    return this.getPrerequisites(courseId);
  }

  async removePrerequisite(courseId: string, prerequisiteId: string) {
    const link = await this.prisma.coursePrerequisite.findUnique({
      where: {
        courseId_prerequisiteId: { courseId, prerequisiteId },
      },
    });
    if (!link) {
      throw new NotFoundException(
        `Course ${courseId} has no prerequisite ${prerequisiteId}`,
      );
    }
    await this.prisma.coursePrerequisite.delete({ where: { id: link.id } });
    this.logger.log(`Prerequisite removed: ${prerequisiteId} ↛ ${courseId}`);
    return { message: 'Prerequisite removed successfully' };
  }

  /**
   * Detects a directed cycle in the "course requires prerequisite" graph
   * using an iterative DFS with coloring. Returns the cycle path or null.
   */
  private findCycle(
    edges: Array<{ courseId: string; prerequisiteId: string }>,
  ): string[] | null {
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!adjacency.has(e.courseId)) adjacency.set(e.courseId, []);
      adjacency.get(e.courseId)!.push(e.prerequisiteId);
    }

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();

    for (const start of adjacency.keys()) {
      if ((color.get(start) ?? WHITE) !== WHITE) continue;

      // stack holds nodes plus their current path index for backtracking
      const stack: Array<{ node: string; pathIndex: number }> = [{ node: start, pathIndex: 0 }];
      const path: string[] = [];

      while (stack.length) {
        const frame = stack[stack.length - 1];
        const neighbors = adjacency.get(frame.node) ?? [];

        if (frame.pathIndex === 0) {
          path.push(frame.node);
          color.set(frame.node, GRAY);
        }

        let advanced = false;
        while (frame.pathIndex < neighbors.length) {
          const next = neighbors[frame.pathIndex];
          frame.pathIndex += 1;
          const nextColor = color.get(next) ?? WHITE;

          if (nextColor === GRAY) {
            const from = path.indexOf(next);
            return [...path.slice(from), next];
          }
          if (nextColor === WHITE) {
            stack.push({ node: next, pathIndex: 0 });
            advanced = true;
            break;
          }
        }

        if (!advanced && frame.pathIndex >= neighbors.length) {
          color.set(frame.node, BLACK);
          path.pop();
          stack.pop();
        }
      }
    }
    return null;
  }
}
