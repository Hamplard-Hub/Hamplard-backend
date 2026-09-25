import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Badge, BadgeRequirementType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export type CreateBadgeInput = {
  code: string;
  name: string;
  description?: string;
  iconUrl?: string;
  requirementType: BadgeRequirementType;
  requirementValue: number;
  isActive?: boolean;
};

export type UpdateBadgeInput = Partial<CreateBadgeInput>;

export type MilestoneEvent = {
  type: BadgeRequirementType;
};

@Injectable()
export class BadgesService {
  constructor(private readonly prisma: PrismaService) {}

  createBadge(input: CreateBadgeInput) {
    return this.prisma.badge.create({ data: input });
  }

  getCatalog() {
    return this.prisma.badge.findMany({ orderBy: { createdAt: 'asc' } });
  }

  getActiveBadges() {
    return this.prisma.badge.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async seedCatalog(badges: CreateBadgeInput[]) {
    await this.prisma.$transaction(
      badges.map((badge) =>
        this.prisma.badge.upsert({
          where: { code: badge.code },
          create: badge,
          update: badge,
        }),
      ),
    );

    return this.getCatalog();
  }

  async updateBadge(id: string, input: UpdateBadgeInput) {
    const badge = await this.prisma.badge.findUnique({ where: { id } });
    if (!badge) {
      throw new NotFoundException('Badge not found');
    }

    return this.prisma.badge.update({ where: { id }, data: input });
  }

  async handleMilestoneEvent(studentId: string, event: MilestoneEvent) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, role: true },
    });
    if (!student) {
      throw new NotFoundException('Student not found');
    }
    if (student.role !== UserRole.STUDENT) {
      throw new BadRequestException('Badges can only be awarded to students');
    }

    return this.prisma.$transaction(async (transaction) => {
      const badges = await transaction.badge.findMany({
        where: { isActive: true, requirementType: event.type },
      });
      const earned = await transaction.studentBadge.findMany({
        where: { studentId },
        select: { badgeId: true },
      });
      const earnedIds = new Set(earned.map(({ badgeId }) => badgeId));
      const eligible: Badge[] = [];

      for (const badge of badges) {
        if (
          !earnedIds.has(badge.id) &&
          (await this.verifyRequirement(transaction, studentId, badge))
        ) {
          eligible.push(badge);
        }
      }

      if (eligible.length > 0) {
        await transaction.studentBadge.createMany({
          data: eligible.map((badge) => ({ studentId, badgeId: badge.id })),
          skipDuplicates: true,
        });
      }

      return {
        studentId,
        awarded: eligible,
        totalAwarded: eligible.length,
      };
    });
  }

  async getStudentShowcase(studentId: string) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true },
    });
    if (!student) {
      throw new NotFoundException('Student not found');
    }

    const badges = await this.prisma.studentBadge.findMany({
      where: { studentId },
      include: { badge: true },
      orderBy: { awardedAt: 'desc' },
    });

    return { studentId, badges };
  }

  private async verifyRequirement(
    transaction: Prisma.TransactionClient,
    studentId: string,
    badge: Badge,
  ): Promise<boolean> {
    switch (badge.requirementType) {
      case BadgeRequirementType.LESSONS_COMPLETED: {
        const enrollments = await transaction.enrollment.findMany({
          where: { studentId },
          select: {
            lessonProgress: { where: { completed: true }, select: { id: true } },
          },
        });
        const completedLessons = enrollments.reduce(
          (total, enrollment) => total + enrollment.lessonProgress.length,
          0,
        );
        return completedLessons >= badge.requirementValue;
      }
      case BadgeRequirementType.COURSES_COMPLETED: {
        const completedCourses = await transaction.enrollment.count({
          where: {
            studentId,
            OR: [{ status: 'COMPLETED' }, { progressPercent: 100 }],
          },
        });
        return completedCourses >= badge.requirementValue;
      }
      case BadgeRequirementType.POINTS_EARNED: {
        const points = await transaction.userPoints.findUnique({
          where: { userId: studentId },
          select: { totalPoints: true },
        });
        return (points?.totalPoints ?? 0) >= badge.requirementValue;
      }
    }
  }
}
