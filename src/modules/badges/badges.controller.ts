import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { BadgeRequirementType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { BadgesService, CreateBadgeInput, UpdateBadgeInput } from './badges.service';

class CreateBadgeDto implements CreateBadgeInput {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsEnum(BadgeRequirementType)
  requirementType!: BadgeRequirementType;

  @IsInt()
  @Min(1)
  requirementValue!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateBadgeDto implements UpdateBadgeInput {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsEnum(BadgeRequirementType)
  requirementType?: BadgeRequirementType;

  @IsOptional()
  @IsInt()
  @Min(1)
  requirementValue?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class MilestoneEventDto {
  @IsEnum(BadgeRequirementType)
  type!: BadgeRequirementType;
}

@ApiTags('badges')
@Controller('badges')
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'List the configured badge catalog' })
  getCatalog() {
    return this.badgesService.getCatalog();
  }

  @Get('catalog/active')
  @ApiOperation({ summary: 'List active badges available for awarding' })
  getActiveBadges() {
    return this.badgesService.getActiveBadges();
  }

  @Post('catalog')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a badge catalog entry' })
  createBadge(@Body() input: CreateBadgeDto) {
    return this.badgesService.createBadge(input);
  }

  @Post('catalog/seed')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create or update badge catalog entries by code' })
  seedCatalog(@Body() badges: CreateBadgeDto[]) {
    return this.badgesService.seedCatalog(badges);
  }

  @Patch('catalog/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a badge catalog entry' })
  updateBadge(@Param('id') id: string, @Body() input: UpdateBadgeDto) {
    return this.badgesService.updateBadge(id, input);
  }

  @Post('students/:studentId/milestones')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Process an earned student milestone and award badges' })
  handleMilestone(
    @Param('studentId') studentId: string,
    @Body() event: MilestoneEventDto,
  ) {
    return this.badgesService.handleMilestoneEvent(studentId, event);
  }

  @Get('students/:studentId/showcase')
  @ApiOperation({ summary: 'List badges earned by a student' })
  getStudentShowcase(@Param('studentId') studentId: string) {
    return this.badgesService.getStudentShowcase(studentId);
  }
}
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
