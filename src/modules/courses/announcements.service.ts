import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, Logger, Inject, forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QueueService } from '../../common/queue/queue.service';
import { NotificationType } from '@prisma/client';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';

export interface CourseActor {
  id: string;
  stellarAddress?: string | null;
  role: string;
}

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);
  private readonly ANNOUNCEMENT_RATE_LIMIT = 100; // per 24 hours per course
  private readonly RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Verify that the user is the course owner or an admin.
   */
  private assertCourseOwner(course: { instructorAddress: string }, user: CourseActor): void {
    if (user.role === 'ADMIN') return;

    const isOwner =
      (!!user.stellarAddress && user.stellarAddress === course.instructorAddress) ||
      user.id === course.instructorAddress;

    if (!isOwner) {
      throw new ForbiddenException('Only the course instructor or an admin can post announcements');
    }
  }

  /**
   * Create an announcement and queue notifications for all enrolled students.
   * Rate-limited to 100 announcements per course per 24 hours.
   */
  async createAnnouncement(
    courseId: string,
    user: CourseActor,
    dto: CreateAnnouncementDto,
  ): Promise<any> {
    // Verify the course exists and user is owner/admin
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });

    if (!course) {
      throw new NotFoundException(`Course ${courseId} not found`);
    }

    // Check authorization: only owner or admin can post announcements
    this.assertCourseOwner(course, user);

    // Check rate limit: announcements in the last 24 hours
    const rateLimitWindow = new Date(Date.now() - this.RATE_LIMIT_WINDOW);
    const recentCount = await this.prisma.announcement.count({
      where: {
        courseId,
        createdAt: { gte: rateLimitWindow },
      },
    });

    if (recentCount >= this.ANNOUNCEMENT_RATE_LIMIT) {
      throw new BadRequestException(
        `Rate limit exceeded: maximum ${this.ANNOUNCEMENT_RATE_LIMIT} announcements per course per 24 hours`,
      );
    }

    // Create the announcement
    const announcement = await this.prisma.announcement.create({
      data: {
        courseId,
        createdById: user.id,
        title: dto.title,
        content: dto.content,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.logger.log(`Announcement created: ${announcement.id} for course ${courseId}`);

    // Queue notification fan-out to all enrolled students
    await this.queueNotificationsForEnrolledStudents(announcement);

    return announcement;
  }

  /**
   * Get announcements for a course. Enrolled students and course owner/admin can view.
   */
  async getAnnouncementsForCourse(
    courseId: string,
    page = 1,
    limit = 20,
    userId?: string,
    userRole?: string,
  ): Promise<any> {
    // Verify course exists
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });

    if (!course) {
      throw new NotFoundException(`Course ${courseId} not found`);
    }

    // Check permissions: owner, admin, or enrolled student
    if (userId && userRole !== 'ADMIN') {
      const isOwner = course.instructorAddress === userId;
      const isEnrolled = await this.prisma.enrollment.findUnique({
        where: { studentId_courseId: { studentId: userId, courseId } },
      });

      if (!isOwner && !isEnrolled) {
        throw new ForbiddenException(
          'You do not have permission to view announcements for this course',
        );
      }
    }

    const [announcements, total] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({
        where: { courseId },
        include: {
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.announcement.count({ where: { courseId } }),
    ]);

    return {
      data: announcements,
      meta: { total, page, limit },
    };
  }

  /**
   * Queue notifications for all enrolled students asynchronously.
   * This fans out to the notification system which handles rate limiting and delivery.
   */
  private async queueNotificationsForEnrolledStudents(announcement: any): Promise<void> {
    // Get all enrolled students for the course
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId: announcement.courseId },
      select: { studentId: true },
    });

    if (!enrollments.length) {
      this.logger.debug(
        `No enrolled students for course ${announcement.courseId}, skipping notifications`,
      );
      return;
    }

    // Get the course title for the notification message
    const course = await this.prisma.course.findUnique({
      where: { id: announcement.courseId },
      select: { title: true },
    });

    // Queue notification for each student
    // We use Promise.allSettled to ensure all notifications are queued even if some fail
    const notificationPromises = enrollments.map((enrollment) =>
      this.notifications.notifyUser(
        enrollment.studentId,
        NotificationType.COURSE_ANNOUNCEMENT,
        announcement.title,
        `Announcement from "${course.title}": ${announcement.content}`,
        {
          announcementId: announcement.id,
          courseId: announcement.courseId,
          instructorName: announcement.createdBy.name,
        },
      ),
    );

    const results = await Promise.allSettled(notificationPromises);

    // Log any failed notifications (but don't throw)
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount > 0) {
      this.logger.warn(
        `${failedCount}/${enrollments.length} notifications failed for announcement ${announcement.id}`,
      );
    } else {
      this.logger.log(
        `Successfully queued ${enrollments.length} notifications for announcement ${announcement.id}`,
      );
    }
  }
}
