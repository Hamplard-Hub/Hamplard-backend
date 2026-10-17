import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FeeCalculatorService } from '../billing/fee-calculator.service';
import { SearchService, CourseSearchDocument } from '../search/search.service';
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
    private readonly searchService: SearchService,
    private readonly cache: CacheService,
  ) {}

  /** Issue #92 — invalidate cached course listings/categories on content updates. */
  private async invalidateCourseCaches(): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace('courses:list'),
      this.cache.invalidateNamespace('courses:categories'),
    ]);
  }

  // -----------------------------------------------------
  // CREATE
  // -----------------------------------------------------

  /**
   * Instructor creates a course draft in the backend DB.
   * The course starts as Draft until the instructor submits it for review.
   * On submission, status becomes PENDING and admin is notified.
   *
   * Does NOT index into search — only ACTIVE courses are searchable.
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

  // -----------------------------------------------------
  // SUBMIT FOR REVIEW
  // -----------------------------------------------------

  /**
   * Instructor submits a DRAFT course for admin review → PENDING.
   * Called after the instructor has also registered the course on-chain.
   */
  async submitForReview(courseId: string, instructorId: string, txHash?: string) {
    const course = await this.findOne(courseId, { isAdmin: true });

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

  // -----------------------------------------------------
  // APPROVE / REJECT (admin)
  // -----------------------------------------------------

  async approve(courseId: string, adminId: string) {
    const course = await this.findOne(courseId, { isAdmin: true });
    if (course.status !== CourseStatus.PENDING) {
      throw new ForbiddenException('Only PENDING courses can be approved');
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status: CourseStatus.ACTIVE, approvedAt: new Date() },
    });

    // Index the approved course into the search engine
    await this.indexCourseForSearch(updated.id);

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
    const course = await this.findOne(courseId, { isAdmin: true });
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

  // -----------------------------------------------------
  // READ
  // -----------------------------------------------------

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

  /**
   * Public course detail view.
   *
   * - Non-ACTIVE courses are hidden (404) unless the caller is the owner or an admin.
   * - Owners/admins receive the full course with all lesson content.
   * - Enrolled students receive the full curriculum.
   * - Anonymous/non-enrolled callers receive a curriculum outline only
   *   (title, type, duration, isFree) and content only for isFree lessons.
   */
  async findOne(
    id: string,
    viewer?: { userId?: string; stellarAddress?: string; isAdmin?: boolean },
  ) {
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

    const isOwner =
      !!viewer?.stellarAddress && viewer.stellarAddress === course.instructorAddress;
    const isAdmin = !!viewer?.isAdmin;

    // Hide non-ACTIVE courses from everyone except the owner and admins.
    if (course.status !== CourseStatus.ACTIVE && !isOwner && !isAdmin) {
      throw new NotFoundException(`Course ${id} not found`);
    }

    // Owners and admins always get the full view.
    if (isOwner || isAdmin) {
      return course;
    }

    // Enrolled students get the full curriculum.
    const isEnrolled = await this.isEnrolled(course.id, viewer);
    if (isEnrolled) {
      return course;
    }

    // Anonymous / non-enrolled callers: return a curriculum outline.
    return this.toPublicOutline(course);
  }

  /** Returns true when the viewer has an active enrollment in the course. */
  private async isEnrolled(
    courseId: string,
    viewer?: { userId?: string; stellarAddress?: string },
  ): Promise<boolean> {
    if (!viewer?.userId && !viewer?.stellarAddress) return false;
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        courseId,
        ...(viewer.userId
          ? { userId: viewer.userId }
          : { user: { stellarAddress: viewer.stellarAddress } }),
      },
      select: { id: true },
    });
    return !!enrollment;
  }

  /**
   * Strips paid lesson content from a course, keeping only the outline
   * fields (title, type, duration, isFree) plus content for free lessons.
   */
  private toPublicOutline(course: any) {
    return {
      ...course,
      modules: course.modules.map((module: any) => ({
        ...module,
        lessons: module.lessons.map((lesson: any) => {
          const base = {
            id: lesson.id,
            moduleId: lesson.moduleId,
            title: lesson.title,
            type: lesson.type,
            duration: lesson.duration,
            position: lesson.position,
            isFree: lesson.isFree,
          };
          if (lesson.isFree) {
            return {
              ...base,
              videoUrl: lesson.videoUrl,
              content: lesson.content,
              resourceUrl: lesson.resourceUrl,
            };
          }
          return base;
        }),
      })),
    };
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
    const course = await this.findOne(courseId, { isAdmin: true });
    if (course.status === CourseStatus.ARCHIVED) {
      throw new ForbiddenException('Cannot update an archived course');
    }

    const updated = await this.prisma.course.update({ where: { id: courseId }, data: dto });

    // Re-index if the course is active (search index should reflect changes)
    if (updated.status === CourseStatus.ACTIVE) {
      await this.indexCourseForSearch(updated.id);
    }

    await this.invalidateCourseCaches();
    return updated;
  }

  private async indexCourseForSearch(courseId: string): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { instructor: { select: { name: true } } },
    });
    if (!course) return;
    const doc: CourseSearchDocument = {
      id: course.id,
      title: course.title,
      description: course.description,
      category: course.category,
      level: course.level,
      instructorName: course.instructor?.name,
    };
    await this.searchService.indexCourse(doc);
  }

  async setPrerequisites(courseId: string, instructorId: string, dto: SetPrerequisitesDto) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    await this.prisma.coursePrerequisite.deleteMany({ where: { courseId } });
    if (dto.prerequisiteCourseIds.length > 0) {
      await this.prisma.coursePrerequisite.createMany({
        data: dto.prerequisiteCourseIds.map((prerequisiteCourseId) => ({
          courseId,
          prerequisiteCourseId,
        })),
      });
    }

    return this.prisma.coursePrerequisite.findMany({ where: { courseId } });
  }
}
