// enrollments.service.ts
import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Register an enrollment in the DB after the student has submitted
   * the enroll() transaction on-chain via Freighter.
   * The backend receives the txHash and registers the enrollment.
   */
  async create(studentId: string, courseId: string, txHash: string, amountPaid: number) {
    const existing = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (existing) throw new ConflictException('Already enrolled in this course');

    const enrollment = await this.prisma.enrollment.create({
      data: {
        studentId,
        courseId,
        txHash,
        amountPaid,
      },
      include: { course: true, student: true },
    });

    // Update course stats
    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        totalEnrollments: { increment: 1 },
        totalRevenue:     { increment: amountPaid },
      },
    });

    // Notify student
    await this.notifications.notifyUser(
      studentId,
      NotificationType.ENROLLMENT_CONFIRMED,
      'Enrollment confirmed!',
      `You are now enrolled in "${enrollment.course.title}". Start learning at your own pace.`,
      { courseId, txHash },
    );

    // Notify instructor
    const instructor = await this.prisma.user.findUnique({
      where: { stellarAddress: enrollment.course.instructorAddress },
    });
    if (instructor) {
      await this.notifications.notifyUser(
        instructor.id,
        NotificationType.NEW_ENROLLMENT,
        'New student enrolled',
        `A new student has enrolled in "${enrollment.course.title}".`,
        { courseId },
      );
    }

    this.logger.log(`Enrollment created: ${studentId} → ${courseId}`);
    return enrollment;
  }

  async findByStudent(studentId: string, page = 1, limit = 20) {
    const [enrollments, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where: { studentId },
        include: {
          course: {
            include: { instructor: { select: { name: true, avatarUrl: true } } },
          },
        },
        orderBy: { enrolledAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.enrollment.count({ where: { studentId } }),
    ]);
    return { data: enrollments, meta: { total, page, limit } };
  }

  async findOne(studentId: string, courseId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: {
        course: {
          include: {
            modules: {
              orderBy: { position: 'asc' },
              include: { lessons: { orderBy: { position: 'asc' } } },
            },
          },
        },
        lessonProgress: true,
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    return enrollment;
  }

  async isEnrolled(studentId: string, courseId: string): Promise<boolean> {
    const count = await this.prisma.enrollment.count({
      where: { studentId, courseId },
    });
    return count > 0;
  }
}
