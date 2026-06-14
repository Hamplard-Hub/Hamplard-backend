import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CourseStatus, NotificationType } from '@prisma/client';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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
    return this.prisma.course.update({ where: { id: courseId }, data: dto });
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
}
