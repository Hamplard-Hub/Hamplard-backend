import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InstructorDashboardQueryDto } from './dto/instructor-dashboard-query.dto';

interface ResolvedPeriod {
  from: Date | null;
  to: Date | null;
}

export interface PerCourseMetrics {
  courseId: string;
  courseName: string;
  enrollments: {
    total: number;
    completed: number;
    completionRate: number;
    activeCount: number;
  };
  ratings: {
    average: number;
    totalReviews: number;
  };
  performance: {
    averageQuizScore: number | null;
    averageExamScore: number | null;
  };
  submissions: {
    pending: number;
    approved: number;
    rejected: number;
  };
}

export interface InstructorDashboardReport {
  instructor: { id: string; name: string | null };
  period: { from: string | null; to: string | null };
  generatedAt: string;
  courseMetrics: PerCourseMetrics[];
  summary: {
    totalCourses: number;
    totalEnrollments: number;
    averageCompletionRate: number;
    averageRating: number;
    totalPendingSubmissions: number;
  };
}

@Injectable()
export class InstructorDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(
    instructorId: string,
    dto: InstructorDashboardQueryDto,
  ): Promise<InstructorDashboardReport> {
    // Verify instructor exists
    const instructor = await this.prisma.user.findUnique({
      where: { id: instructorId },
      select: { id: true, name: true, role: true, stellarAddress: true },
    });
    if (!instructor) throw new NotFoundException('Instructor not found');
    if (instructor.role !== 'INSTRUCTOR') {
      throw new BadRequestException('User is not an instructor');
    }

    const period = this.resolvePeriod(dto);

    // Get all courses for this instructor
    const courses = await this.prisma.course.findMany({
      where: { instructorAddress: instructor.stellarAddress ?? '__none__' },
      select: { id: true, title: true },
    });

    if (courses.length === 0) {
      return {
        instructor: { id: instructor.id, name: instructor.name },
        period: {
          from: period.from ? period.from.toISOString() : null,
          to: period.to ? period.to.toISOString() : null,
        },
        generatedAt: new Date().toISOString(),
        courseMetrics: [],
        summary: {
          totalCourses: 0,
          totalEnrollments: 0,
          averageCompletionRate: 0,
          averageRating: 0,
          totalPendingSubmissions: 0,
        },
      };
    }

    const courseIds = courses.map((c) => c.id);

    // Fetch all metrics in parallel
    const [enrollmentData, reviewData, quizData, examData, assignmentData] =
      await Promise.all([
        this.getEnrollmentMetrics(courseIds, period),
        this.getReviewMetrics(courseIds, period),
        this.getQuizMetrics(courseIds, period),
        this.getExamMetrics(courseIds, period),
        this.getAssignmentMetrics(courseIds),
      ]);

    // Build per-course metrics
    const courseMetrics = courses.map((course) => {
      const enrollments = enrollmentData[course.id] || {
        total: 0,
        completed: 0,
        active: 0,
      };
      const reviews = reviewData[course.id] || {
        average: 0,
        count: 0,
      };
      const quizzes = quizData[course.id] || { averageScore: null };
      const exams = examData[course.id] || { averageScore: null };
      const submissions = assignmentData[course.id] || {
        pending: 0,
        approved: 0,
        rejected: 0,
      };

      return {
        courseId: course.id,
        courseName: course.title,
        enrollments: {
          total: enrollments.total,
          completed: enrollments.completed,
          completionRate: this.rate(enrollments.completed, enrollments.total),
          activeCount: enrollments.active,
        },
        ratings: {
          average: this.round(reviews.average),
          totalReviews: reviews.count,
        },
        performance: {
          averageQuizScore: quizzes.averageScore,
          averageExamScore: exams.averageScore,
        },
        submissions: {
          pending: submissions.pending,
          approved: submissions.approved,
          rejected: submissions.rejected,
        },
      };
    });

    // Calculate summary
    const totalEnrollments = courseMetrics.reduce(
      (sum, m) => sum + m.enrollments.total,
      0,
    );
    const totalCompleted = courseMetrics.reduce(
      (sum, m) => sum + m.enrollments.completed,
      0,
    );
    const averageCompletionRate = this.rate(totalCompleted, totalEnrollments);
    const averageRating =
      courseMetrics.length > 0
        ? this.round(
            courseMetrics.reduce((sum, m) => sum + m.ratings.average, 0) /
              courseMetrics.length,
          )
        : 0;
    const totalPendingSubmissions = courseMetrics.reduce(
      (sum, m) => sum + m.submissions.pending,
      0,
    );

    return {
      instructor: { id: instructor.id, name: instructor.name },
      period: {
        from: period.from ? period.from.toISOString() : null,
        to: period.to ? period.to.toISOString() : null,
      },
      generatedAt: new Date().toISOString(),
      courseMetrics,
      summary: {
        totalCourses: courses.length,
        totalEnrollments,
        averageCompletionRate,
        averageRating,
        totalPendingSubmissions,
      },
    };
  }

  // ----------------------------------------------------------
  // ENROLLMENT METRICS
  // ----------------------------------------------------------

  private async getEnrollmentMetrics(
    courseIds: string[],
    period: ResolvedPeriod,
  ): Promise<
    Record<string, { total: number; completed: number; active: number }>
  > {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        courseId: { in: courseIds },
        ...this.dateFilter('enrolledAt', period),
      },
      select: { courseId: true, status: true },
    });

    const result: Record<string, { total: number; completed: number; active: number }> =
      {};

    for (const courseId of courseIds) {
      result[courseId] = { total: 0, completed: 0, active: 0 };
    }

    for (const enrollment of enrollments) {
      result[enrollment.courseId].total++;
      if (enrollment.status === 'COMPLETED') {
        result[enrollment.courseId].completed++;
      } else if (enrollment.status === 'ACTIVE') {
        result[enrollment.courseId].active++;
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // REVIEW METRICS
  // ----------------------------------------------------------

  private async getReviewMetrics(
    courseIds: string[],
    period: ResolvedPeriod,
  ): Promise<Record<string, { average: number; count: number }>> {
    const reviews = await this.prisma.courseReview.groupBy({
      by: ['courseId'],
      where: {
        courseId: { in: courseIds },
        ...this.dateFilter('createdAt', period),
      },
      _avg: { rating: true },
      _count: { _all: true },
    });

    const result: Record<string, { average: number; count: number }> = {};

    for (const courseId of courseIds) {
      result[courseId] = { average: 0, count: 0 };
    }

    for (const review of reviews) {
      result[review.courseId] = {
        average: this.toNumber(review._avg.rating ?? 0),
        count: review._count._all,
      };
    }

    return result;
  }

  // ----------------------------------------------------------
  // QUIZ METRICS
  // ----------------------------------------------------------

  private async getQuizMetrics(
    courseIds: string[],
    period: ResolvedPeriod,
  ): Promise<Record<string, { averageScore: number | null }>> {
    // Get modules and lessons for the courses
    const modules = await this.prisma.courseModule.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });

    const moduleIds = modules.map((m) => m.id);

    if (moduleIds.length === 0) {
      const result: Record<string, { averageScore: number | null }> = {};
      for (const courseId of courseIds) {
        result[courseId] = { averageScore: null };
      }
      return result;
    }

    const lessons = await this.prisma.lesson.findMany({
      where: { moduleId: { in: moduleIds } },
      select: { id: true, moduleId: true },
    });

    const lessonIds = lessons.map((l) => l.id);

    if (lessonIds.length === 0) {
      const result: Record<string, { averageScore: number | null }> = {};
      for (const courseId of courseIds) {
        result[courseId] = { averageScore: null };
      }
      return result;
    }

    const quizAttempts = await this.prisma.quizAttempt.groupBy({
      by: ['lessonId'],
      where: {
        lessonId: { in: lessonIds },
        ...this.dateFilter('attemptedAt', period),
      },
      _avg: { score: true },
    });

    // Map quiz scores back to courses
    const moduleToCourseLookup = new Map(modules.map((m) => [m.id, m.courseId]));
    const lessonToModule = new Map(lessons.map((l) => [l.id, l.moduleId]));
    const result: Record<string, { averageScore: number | null }> = {};

    for (const courseId of courseIds) {
      result[courseId] = { averageScore: null };
    }

    const courseScores: Record<string, number[]> = {};
    for (const courseId of courseIds) {
      courseScores[courseId] = [];
    }

    for (const attempt of quizAttempts) {
      const moduleId = lessonToModule.get(attempt.lessonId);
      if (moduleId) {
        const courseId = moduleToCourseLookup.get(moduleId);
        if (courseId) {
          courseScores[courseId].push(this.toNumber(attempt._avg.score ?? 0));
        }
      }
    }

    for (const courseId of courseIds) {
      if (courseScores[courseId].length > 0) {
        const avg =
          courseScores[courseId].reduce((a, b) => a + b, 0) /
          courseScores[courseId].length;
        result[courseId].averageScore = this.round(avg);
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // EXAM METRICS
  // ----------------------------------------------------------

  private async getExamMetrics(
    courseIds: string[],
    period: ResolvedPeriod,
  ): Promise<Record<string, { averageScore: number | null }>> {
    const exams = await this.prisma.exam.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });

    const examIds = exams.map((e) => e.id);

    if (examIds.length === 0) {
      const result: Record<string, { averageScore: number | null }> = {};
      for (const courseId of courseIds) {
        result[courseId] = { averageScore: null };
      }
      return result;
    }

    const examAttempts = await this.prisma.examAttempt.groupBy({
      by: ['examId'],
      where: {
        examId: { in: examIds },
        ...this.dateFilter('attemptedAt', period),
      },
      _avg: { score: true },
    });

    // Map exam scores back to courses
    const examToCourse = new Map(exams.map((e) => [e.id, e.courseId]));
    const result: Record<string, { averageScore: number | null }> = {};

    for (const courseId of courseIds) {
      result[courseId] = { averageScore: null };
    }

    const courseScores: Record<string, number[]> = {};
    for (const courseId of courseIds) {
      courseScores[courseId] = [];
    }

    for (const attempt of examAttempts) {
      const courseId = examToCourse.get(attempt.examId);
      if (courseId) {
        courseScores[courseId].push(this.toNumber(attempt._avg.score ?? 0));
      }
    }

    for (const courseId of courseIds) {
      if (courseScores[courseId].length > 0) {
        const avg =
          courseScores[courseId].reduce((a, b) => a + b, 0) /
          courseScores[courseId].length;
        result[courseId].averageScore = this.round(avg);
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // ASSIGNMENT METRICS
  // ----------------------------------------------------------

  private async getAssignmentMetrics(
    courseIds: string[],
  ): Promise<
    Record<string, { pending: number; approved: number; rejected: number }>
  > {
    // Get modules and lessons for courses
    const modules = await this.prisma.courseModule.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });

    const moduleIds = modules.map((m) => m.id);

    if (moduleIds.length === 0) {
      const result: Record<
        string,
        { pending: number; approved: number; rejected: number }
      > = {};
      for (const courseId of courseIds) {
        result[courseId] = { pending: 0, approved: 0, rejected: 0 };
      }
      return result;
    }

    const lessons = await this.prisma.lesson.findMany({
      where: { moduleId: { in: moduleIds } },
      select: { id: true, moduleId: true },
    });

    const lessonIds = lessons.map((l) => l.id);

    if (lessonIds.length === 0) {
      const result: Record<
        string,
        { pending: number; approved: number; rejected: number }
      > = {};
      for (const courseId of courseIds) {
        result[courseId] = { pending: 0, approved: 0, rejected: 0 };
      }
      return result;
    }

    // Get assignment submissions
    const submissions = await this.prisma.assignmentSubmission.findMany({
      where: {
        assignment: {
          lessonId: { in: lessonIds },
        },
      },
      select: {
        status: true,
        assignment: { select: { lessonId: true } },
      },
    });

    // Map results back to courses
    const moduleToCourseLookup = new Map(modules.map((m) => [m.id, m.courseId]));
    const lessonToModule = new Map(lessons.map((l) => [l.id, l.moduleId]));
    const result: Record<
      string,
      { pending: number; approved: number; rejected: number }
    > = {};

    for (const courseId of courseIds) {
      result[courseId] = { pending: 0, approved: 0, rejected: 0 };
    }

    for (const submission of submissions) {
      const moduleId = lessonToModule.get(submission.assignment.lessonId);
      if (moduleId) {
        const courseId = moduleToCourseLookup.get(moduleId);
        if (courseId) {
          if (submission.status === 'PENDING') {
            result[courseId].pending++;
          } else if (submission.status === 'APPROVED') {
            result[courseId].approved++;
          } else if (submission.status === 'REJECTED') {
            result[courseId].rejected++;
          }
        }
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private resolvePeriod(dto: InstructorDashboardQueryDto): ResolvedPeriod {
    const from = dto.from ? new Date(dto.from) : null;
    const to = dto.to ? new Date(dto.to) : null;

    if (from && Number.isNaN(from.getTime())) {
      throw new BadRequestException('from is not a valid date');
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new BadRequestException('to is not a valid date');
    }
    if (from && to && from > to) {
      throw new BadRequestException('from must be on or before to');
    }
    return { from, to };
  }

  private dateFilter(
    field: 'enrolledAt' | 'createdAt' | 'attemptedAt',
    period: ResolvedPeriod,
  ): Record<string, Prisma.DateTimeFilter> | Record<string, never> {
    if (!period.from && !period.to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (period.from) range.gte = period.from;
    if (period.to) range.lte = period.to;
    return { [field]: range };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    return typeof value === 'number' ? value : Number(value);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private rate(numerator: number, denominator: number): number {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 10000) / 10000;
  }
}
