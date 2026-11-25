// assignments.service.ts
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AssignmentStatus, EnrollmentStatus, NotificationType } from '@prisma/client';

/** Enrollment states allowed to submit assignments (issue #244). */
const SUBMITTABLE_ENROLLMENT_STATUSES: EnrollmentStatus[] = [
  EnrollmentStatus.ACTIVE,
  EnrollmentStatus.COMPLETED,
];

/** Authenticated caller as attached by JwtStrategy. */
export interface AssignmentViewer {
  id: string;
  role: UserRole | string;
}

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Helper to verify instructor owns the lesson's course, or user is admin.
   */
  private async verifyLessonOwnership(lessonId: string, userId: string, userRole: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        module: {
          include: {
            course: { include: { instructor: { select: { id: true } } } },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    if (userRole !== UserRole.ADMIN) {
      const course = lesson.module.course;
      // userId is a User UUID; course.instructorAddress is a Stellar address, so compare by id.
      if (course.instructor?.id !== userId) {
        throw new ForbiddenException('You are not authorized to manage assignments for this course');
      }
    }

    return lesson;
  }

  async create(
    lessonId: string,
    data: {
      title: string;
      description: string;
      instructions?: string;
    },
    userId: string,
    userRole: string,
  ) {
    await this.verifyLessonOwnership(lessonId, userId, userRole);

    return this.prisma.assignment.create({
      data: { lessonId, ...data },
    });
  }

  /**
   * Issue #244 — the course instructor and admins see every submission;
   * anyone else only sees their own.
   */
  async findByLesson(lessonId: string, user: AssignmentViewer) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { lessonId },
      include: {
        submissions: { include: { student: { select: { name: true, stellarAddress: true } } } },
        lesson: {
          select: {
            module: {
              select: { course: { select: { instructor: { select: { id: true } } } } },
            },
          },
        },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found for this lesson');

    const { lesson, submissions, ...rest } = assignment;
    const canSeeAll =
      user.role === UserRole.ADMIN || lesson?.module?.course?.instructor?.id === user.id;

    return {
      ...rest,
      submissions: canSeeAll
        ? submissions
        : submissions.filter((s) => s.studentId === user.id),
    };
  }

  /**
   * Student submits their practical assignment (e.g. photo of finished garment,
   * video of makeup result, baked product photo). The submission URL is typically
   * an uploaded file from the UploadsModule.
   */
  async submit(
    studentId: string,
    assignmentId: string,
    submissionUrl: string,
    notes?: string,
  ) {
    // Issue #244 — unknown IDs are a 404 (not an FK error), and only students
    // enrolled in the parent course may submit.
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        lesson: { select: { module: { select: { courseId: true } } } },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        studentId_courseId: { studentId, courseId: assignment.lesson.module.courseId },
      },
      select: { status: true },
    });
    if (!enrollment || !SUBMITTABLE_ENROLLMENT_STATUSES.includes(enrollment.status)) {
      throw new ForbiddenException('You must be enrolled in this course to submit this assignment');
    }

    const existing = await this.prisma.assignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId } },
    });

    if (existing && existing.status === AssignmentStatus.APPROVED) {
      throw new ForbiddenException('Assignment already approved — cannot resubmit');
    }

    const submission = await this.prisma.assignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId, studentId } },
      create: {
        assignmentId,
        studentId,
        submissionUrl,
        notes,
        status: AssignmentStatus.SUBMITTED,
      },
      update: {
        submissionUrl,
        notes,
        status: AssignmentStatus.SUBMITTED,
        submittedAt: new Date(),
      },
      include: {
        assignment: {
          include: { lesson: { include: { module: { include: { course: true } } } } },
        },
      },
    });

    // Notify instructor
    const instructorAddress = submission.assignment.lesson.module.course.instructorAddress;
    const instructor = await this.prisma.user.findUnique({
      where: { stellarAddress: instructorAddress },
    });
    if (instructor) {
      await this.notifications.notifyUser(
        instructor.id,
        NotificationType.ASSIGNMENT_SUBMITTED,
        'New assignment submission',
        `A student has submitted the assignment "${submission.assignment.title}". Please review.`,
        { assignmentId, studentId },
      );
    }

    this.logger.log(`Assignment ${assignmentId} submitted by student ${studentId}`);
    return submission;
  }

  /**
   * Instructor reviews a submission — approves or rejects with feedback.
   */
  async review(
    submissionId: string,
    instructorId: string,
    approved: boolean,
    feedback: string,
    userRole: string,
  ) {
    const submission = await this.prisma.assignmentSubmission.findUnique({
      where: { id: submissionId },
      include: {
        assignment: {
          include: {
            lesson: {
              include: {
                module: {
                  include: {
                    course: { include: { instructor: { select: { id: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!submission) throw new NotFoundException('Submission not found');

    // Verify ownership
    if (userRole !== UserRole.ADMIN) {
      const course = submission.assignment.lesson.module.course;
      if (course.instructor?.id !== instructorId) {
        throw new ForbiddenException('You are not authorized to review assignments for this course');
      }
    }

    const updated = await this.prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        status:     approved ? AssignmentStatus.APPROVED : AssignmentStatus.REJECTED,
        feedback,
        reviewedAt: new Date(),
      },
    });

    // Notify student
    await this.notifications.notifyUser(
      submission.studentId,
      approved ? NotificationType.ASSIGNMENT_APPROVED : NotificationType.ASSIGNMENT_REJECTED,
      approved ? 'Assignment approved! 🎉' : 'Assignment needs revision',
      approved
        ? `Your assignment "${submission.assignment.title}" has been approved. Great work!`
        : `Your assignment "${submission.assignment.title}" needs revision. Feedback: ${feedback}`,
      { assignmentId: submission.assignmentId, submissionId },
    );

    return updated;
  }

  async findSubmissionsByStudent(studentId: string) {
    return this.prisma.assignmentSubmission.findMany({
      where: { studentId },
      include: { assignment: { include: { lesson: true } } },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /**
   * Issue #434 — scope by the instructor relation (user id), never by the
   * optional Stellar address. Google-only users have no address, and a missing
   * address must never turn into an unfiltered platform-wide query.
   */
  async findPendingForInstructor(
    instructorId: string,
    page?: number,
    limit?: number,
  ) {
    if (!instructorId) {
      throw new BadRequestException('Instructor identifier is required');
    }

    const pageNum = Math.max(1, page ?? 1);
    const pageLimit = Math.min(100, Math.max(1, limit ?? 20));
    const skip = (pageNum - 1) * pageLimit;
    const instructorScope: Prisma.AssignmentSubmissionWhereInput = {
      assignment: {
        lesson: {
          module: {
            course: { instructor: { id: instructorId } },
          },
        },
      },
    };

    const [data, total] = await Promise.all([
      this.prisma.assignmentSubmission.findMany({
        where: {
          status: AssignmentStatus.SUBMITTED,
          ...instructorScope,
        },
        include: {
          assignment: { include: { lesson: true } },
          student:    { select: { name: true, stellarAddress: true } },
        },
        orderBy: { submittedAt: 'asc' },
        skip,
        take: pageLimit,
      }),
      this.prisma.assignmentSubmission.count({
        where: {
          status: AssignmentStatus.SUBMITTED,
          ...instructorScope,
        },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: pageLimit,
        totalPages: Math.ceil(total / pageLimit) || 0,
      },
    };
  }
}
