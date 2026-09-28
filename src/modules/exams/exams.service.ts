import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { SubmitExamDto } from './dto/submit-exam.dto';
import { UserRole } from '@prisma/client';

@Injectable()
export class ExamsService {
  private readonly logger = new Logger(ExamsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or update exam for a course (instructor operation).
   */
  async createOrUpdateExam(instructorId: string, dto: CreateExamDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      include: { instructor: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (course.instructor.id !== instructorId && course.instructorAddress !== instructorId) {
      throw new ForbiddenException('Only the course instructor can manage exams');
    }

    const existingExam = await this.prisma.exam.findUnique({
      where: { courseId: dto.courseId },
    });

    if (existingExam) {
      return this.prisma.exam.update({
        where: { id: existingExam.id },
        data: {
          title: dto.title,
          description: dto.description,
          passingScore: dto.passingScore ?? existingExam.passingScore,
          cooldownHours: dto.cooldownHours ?? existingExam.cooldownHours,
          questions: dto.questions as any,
        },
      });
    }

    return this.prisma.exam.create({
      data: {
        courseId: dto.courseId,
        title: dto.title,
        description: dto.description,
        passingScore: dto.passingScore ?? 70,
        cooldownHours: dto.cooldownHours ?? 24,
        questions: dto.questions as any,
      },
    });
  }

  /**
   * Get exam by courseId or examId.
   */
  async getExamByCourse(courseId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { courseId },
    });
    if (!exam) {
      throw new NotFoundException('Exam not found for this course');
    }
    return exam;
  }

  async getExamById(examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
    });
    if (!exam) {
      throw new NotFoundException('Exam not found');
    }
    return exam;
  }

  /**
   * Check if a student is eligible to take the exam.
   */
  async checkEligibility(studentId: string, examId: string) {
    const exam = await this.getExamById(examId);

    // Verify course enrollment & completion progress
    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        studentId_courseId: {
          studentId,
          courseId: exam.courseId,
        },
      },
    });

    if (!enrollment) {
      return {
        eligible: false,
        reason: 'Student is not enrolled in this course',
      };
    }

    if (enrollment.progressPercent < 100 && enrollment.status !== 'COMPLETED') {
      return {
        eligible: false,
        reason: 'Course lessons must be 100% completed prior to taking the certification exam',
      };
    }

    // Check last attempt and retake cooldown
    const lastAttempt = await this.prisma.examAttempt.findFirst({
      where: { examId, studentId },
      orderBy: { attemptedAt: 'desc' },
    });

    if (lastAttempt) {
      if (lastAttempt.passed) {
        return {
          eligible: false,
          reason: 'Student has already passed this exam',
          passed: true,
        };
      }

      const now = new Date();
      const cooldownEnd = new Date(
        lastAttempt.attemptedAt.getTime() + exam.cooldownHours * 60 * 60 * 1000,
      );

      if (now < cooldownEnd) {
        const remainingMinutes = Math.ceil(
          (cooldownEnd.getTime() - now.getTime()) / (60 * 1000),
        );
        return {
          eligible: false,
          reason: `Retake cooldown in effect. Please try again in ${remainingMinutes} minutes`,
          cooldownEndsAt: cooldownEnd,
          remainingMinutes,
        };
      }
    }

    return { eligible: true };
  }

  /**
   * Submit an exam attempt, validate passing score, and track history.
   */
  async submitExam(studentId: string, examId: string, dto: SubmitExamDto) {
    const eligibility = await this.checkEligibility(studentId, examId);
    if (!eligibility.eligible) {
      throw new ForbiddenException(eligibility.reason);
    }

    const exam = await this.getExamById(examId);
    const questions: any[] = (exam.questions as any[]) || [];

    if (questions.length === 0) {
      throw new BadRequestException('Exam contains no questions');
    }

    let earnedPoints = 0;
    let totalPoints = 0;

    questions.forEach((q) => {
      const qPoints = q.points || 1;
      totalPoints += qPoints;
      const studentAnswer = dto.answers[q.id];

      if (studentAnswer !== undefined && studentAnswer !== null) {
        const correctAnswers = Array.isArray(q.correctAnswer)
          ? q.correctAnswer
          : [q.correctAnswer];
        const answersProvided = Array.isArray(studentAnswer)
          ? studentAnswer
          : [studentAnswer];

        const isCorrect =
          correctAnswers.length === answersProvided.length &&
          correctAnswers.every((val) => answersProvided.includes(val));

        if (isCorrect) {
          earnedPoints += qPoints;
        }
      }
    });

    const scorePercentage = Math.round((earnedPoints / (totalPoints || 1)) * 100);
    const passed = scorePercentage >= exam.passingScore;

    const attempt = await this.prisma.examAttempt.create({
      data: {
        examId,
        studentId,
        score: scorePercentage,
        passed,
        answers: dto.answers as any,
      },
    });

    this.logger.log(
      `Exam attempt recorded: Exam ${examId}, Student ${studentId}, Score ${scorePercentage}%, Passed: ${passed}`,
    );

    return {
      attemptId: attempt.id,
      score: scorePercentage,
      passingScore: exam.passingScore,
      passed,
      attemptedAt: attempt.attemptedAt,
    };
  }

  /**
   * Track attempt history for a student.
   */
  async getAttemptHistory(studentId: string, examId: string) {
    return this.prisma.examAttempt.findMany({
      where: { studentId, examId },
      orderBy: { attemptedAt: 'desc' },
    });
  }

  /**
   * Check if a student has passed the exam for a given course.
   */
  async hasPassedExam(studentId: string, courseId: string): Promise<boolean> {
    const exam = await this.prisma.exam.findUnique({
      where: { courseId },
    });

    if (!exam) {
      // If course has no exam, default to true (exam not required)
      return true;
    }

    const passedAttempt = await this.prisma.examAttempt.findFirst({
      where: {
        examId: exam.id,
        studentId,
        passed: true,
      },
    });

    return !!passedAttempt;
  }

  /**
   * Delete an exam for a course (instructor-owner or admin operation).
   */
  async deleteExam(examId: string, userId: string, userRole?: UserRole) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        course: { include: { instructor: true } },
      },
    });

    if (!exam) {
      throw new NotFoundException('Exam not found');
    }

    const isAdmin = userRole === UserRole.ADMIN;
    const isOwner =
      exam.course?.instructor?.id === userId ||
      exam.course?.instructorAddress === userId;

    if (!isAdmin && !isOwner) {
      throw new ForbiddenException('Only the course instructor or an admin can delete this exam');
    }

    const existingAttempt = await this.prisma.examAttempt.findFirst({
      where: { examId },
    });

    if (existingAttempt) {
      throw new BadRequestException('Cannot delete exam with existing student attempts');
    }

    return this.prisma.exam.delete({
      where: { id: examId },
    });
  }
}
