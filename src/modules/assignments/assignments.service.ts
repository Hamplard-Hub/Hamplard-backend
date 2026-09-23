// assignments.service.ts
import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AssignmentStatus, NotificationType } from '@prisma/client';

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
            course: true,
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    if (userRole !== UserRole.ADMIN) {
      const course = lesson.module.course;
      if (course.instructorAddress !== userId && course.instructor?.id !== userId) {
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

  async findByLesson(lessonId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { lessonId },
      include: { submissions: { include: { student: { select: { name: true, stellarAddress: true } } } } },
    });
    if (!assignment) throw new NotFoundException('Assignment not found for this lesson');
    return assignment;
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
                    course: true,
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
      if (course.instructorAddress !== instructorId && course.instructor?.id !== instructorId) {
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

  async findPendingForInstructor(
    instructorAddress: string,
    page?: number,
    limit?: number,
  ) {
    const pageNum = Math.max(1, page ?? 1);
    const pageLimit = Math.min(100, Math.max(1, limit ?? 20));
    const skip = (pageNum - 1) * pageLimit;

    const [data, total] = await Promise.all([
      this.prisma.assignmentSubmission.findMany({
        where: {
          status: AssignmentStatus.SUBMITTED,
          assignment: {
            lesson: {
              module: {
                course: { instructorAddress },
              },
            },
          },
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
          assignment: {
            lesson: {
              module: {
                course: { instructorAddress },
              },
            },
          },
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
