import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditAction, AuditTargetType, UserRole } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        enrollments: { include: { course: true }, take: 10, orderBy: { enrolledAt: 'desc' } },
        certificates: { include: { course: true }, orderBy: { issuedAt: 'desc' } },
        coursesCreated: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByAddress(stellarAddress: string) {
    const user = await this.prisma.user.findUnique({ where: { stellarAddress } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(query: { role?: UserRole; isBanned?: boolean; isSuspended?: boolean; search?: string; page?: number; limit?: number }) {
    const pageNum = Math.max(1, query.page ?? 1);
    const limitNum = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (query.role) where.role = query.role;
    if (typeof query.isBanned === 'boolean') where.isBanned = query.isBanned;
    if (typeof query.isSuspended === 'boolean') where.isSuspended = query.isSuspended;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { stellarAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stellarAddress: true,
          email: true,
          name: true,
          bio: true,
          avatarUrl: true,
          role: true,
          isVerified: true,
          isBanned: true,
          bannedAt: true,
          banReason: true,
          isSuspended: true,
          suspendedAt: true,
          suspendedUntil: true,
          suspensionReason: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    };
  }

  async updateProfile(id: string, data: { name?: string; email?: string; bio?: string; avatarUrl?: string }) {
    return this.prisma.user.update({ where: { id }, data });
  }

  async getInstructorStats(instructorAddress: string) {
    const courses = await this.prisma.course.findMany({
      where: { instructorAddress },
      include: { _count: { select: { enrollments: true } } },
    });
    const totalStudents = courses.reduce((s, c) => s + c._count.enrollments, 0);
    const totalRevenue = courses.reduce((s, c) => s + Number(c.totalRevenue), 0);
    return { totalCourses: courses.length, totalStudents, totalRevenue, courses };
  }

  async banUser(userId: string, adminId: string, reason: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.isBanned) throw new BadRequestException('User is already banned');
    if (user.role === 'ADMIN') throw new ForbiddenException('Cannot ban admin users');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: true,
        bannedAt: new Date(),
        banReason: reason,
        isSuspended: false,
        suspendedAt: null,
        suspendedUntil: null,
        suspensionReason: null,
      },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_BANNED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: { reason, userEmail: user.email, userName: user.name, stellarAddress: user.stellarAddress },
        ipAddress,
      },
    });

    return updatedUser;
  }

  async unbanUser(userId: string, adminId: string, reason?: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isBanned) throw new BadRequestException('User is not banned');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, bannedAt: null, banReason: null },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_UNBANNED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: { reason: reason || 'No reason provided', userEmail: user.email, userName: user.name },
        ipAddress,
      },
    });

    return updatedUser;
  }

  async suspendUser(userId: string, adminId: string, reason: string, suspendedUntil: Date, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.isBanned) throw new BadRequestException('User is banned. Unban the user first before suspending.');
    if (user.isSuspended) throw new BadRequestException('User is already suspended');
    if (user.role === 'ADMIN') throw new ForbiddenException('Cannot suspend admin users');
    if (suspendedUntil <= new Date()) throw new BadRequestException('Suspension end date must be in the future');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isSuspended: true, suspendedAt: new Date(), suspendedUntil, suspensionReason: reason },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_SUSPENDED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: { reason, suspendedUntil: suspendedUntil.toISOString(), userEmail: user.email, userName: user.name },
        ipAddress,
      },
    });

    return updatedUser;
  }

  async unsuspendUser(userId: string, adminId: string, reason?: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.isSuspended) throw new BadRequestException('User is not suspended');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isSuspended: false, suspendedAt: null, suspendedUntil: null, suspensionReason: null },
    });

    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_UNSUSPENDED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: { reason: reason || 'No reason provided', userEmail: user.email, userName: user.name },
        ipAddress,
      },
    });

    return updatedUser;
  }

  async checkAccountStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, isBanned: true, bannedAt: true, banReason: true,
        isSuspended: true, suspendedAt: true, suspendedUntil: true, suspensionReason: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.isSuspended && user.suspendedUntil && user.suspendedUntil <= new Date()) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { isSuspended: false, suspendedAt: null, suspendedUntil: null, suspensionReason: null },
      });
      return { isActive: true, isBanned: false, isSuspended: false };
    }

    return {
      isActive: !user.isBanned && !user.isSuspended,
      isBanned: user.isBanned,
      banReason: user.banReason,
      bannedAt: user.bannedAt,
      isSuspended: user.isSuspended,
      suspensionReason: user.suspensionReason,
      suspendedAt: user.suspendedAt,
      suspendedUntil: user.suspendedUntil,
    };
  }
}