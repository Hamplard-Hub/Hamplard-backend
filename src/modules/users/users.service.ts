// users.service.ts
import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditAction, AuditTargetType } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) { }

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

  async updateProfile(
    id: string,
    data: { name?: string; email?: string; bio?: string; avatarUrl?: string },
  ) {
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

  /**
   * Ban a user permanently
   * @param userId - User ID to ban
   * @param adminId - Admin performing the ban
   * @param reason - Reason for the ban
   * @param ipAddress - IP address of the admin (for audit log)
   * @returns Updated user
   */
  async banUser(userId: string, adminId: string, reason: string, ipAddress?: string) {
    // Verify user exists and is not already banned
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isBanned) {
      throw new BadRequestException('User is already banned');
    }

    // Prevent banning admins
    if (user.role === 'ADMIN') {
      throw new ForbiddenException('Cannot ban admin users');
    }

    // Update user status
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: true,
        bannedAt: new Date(),
        banReason: reason,
        // Also clear suspension if any
        isSuspended: false,
        suspendedAt: null,
        suspendedUntil: null,
        suspensionReason: null,
      },
    });

    // Create audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_BANNED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: {
          reason,
          userEmail: user.email,
          userName: user.name,
          stellarAddress: user.stellarAddress,
        },
        ipAddress,
      },
    });

    return updatedUser;
  }

  /**
   * Unban a user
   * @param userId - User ID to unban
   * @param adminId - Admin performing the unban
   * @param reason - Reason for unbanning (optional)
   * @param ipAddress - IP address of the admin (for audit log)
   * @returns Updated user
   */
  async unbanUser(userId: string, adminId: string, reason?: string, ipAddress?: string) {
    // Verify user exists and is banned
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.isBanned) {
      throw new BadRequestException('User is not banned');
    }

    // Update user status
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: false,
        bannedAt: null,
        banReason: null,
      },
    });

    // Create audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_UNBANNED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: {
          reason: reason || 'No reason provided',
          userEmail: user.email,
          userName: user.name,
          stellarAddress: user.stellarAddress,
          previousBanReason: user.banReason,
          bannedAt: user.bannedAt,
        },
        ipAddress,
      },
    });

    return updatedUser;
  }

  /**
   * Suspend a user temporarily
   * @param userId - User ID to suspend
   * @param adminId - Admin performing the suspension
   * @param reason - Reason for the suspension
   * @param suspendedUntil - Date when suspension ends
   * @param ipAddress - IP address of the admin (for audit log)
   * @returns Updated user
   */
  async suspendUser(
    userId: string,
    adminId: string,
    reason: string,
    suspendedUntil: Date,
    ipAddress?: string,
  ) {
    // Verify user exists and is not already suspended or banned
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isBanned) {
      throw new BadRequestException('User is banned. Unban the user first before suspending.');
    }

    if (user.isSuspended) {
      throw new BadRequestException('User is already suspended');
    }

    // Prevent suspending admins
    if (user.role === 'ADMIN') {
      throw new ForbiddenException('Cannot suspend admin users');
    }

    // Validate suspension date
    if (suspendedUntil <= new Date()) {
      throw new BadRequestException('Suspension end date must be in the future');
    }

    // Update user status
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspendedUntil,
        suspensionReason: reason,
      },
    });

    // Create audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_SUSPENDED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: {
          reason,
          suspendedUntil: suspendedUntil.toISOString(),
          userEmail: user.email,
          userName: user.name,
          stellarAddress: user.stellarAddress,
        },
        ipAddress,
      },
    });

    return updatedUser;
  }

  /**
   * Lift suspension from a user
   * @param userId - User ID to unsuspend
   * @param adminId - Admin performing the action
   * @param reason - Reason for lifting suspension early (optional)
   * @param ipAddress - IP address of the admin (for audit log)
   * @returns Updated user
   */
  async unsuspendUser(userId: string, adminId: string, reason?: string, ipAddress?: string) {
    // Verify user exists and is suspended
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.isSuspended) {
      throw new BadRequestException('User is not suspended');
    }

    // Update user status
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isSuspended: false,
        suspendedAt: null,
        suspendedUntil: null,
        suspensionReason: null,
      },
    });

    // Create audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.USER_UNSUSPENDED,
        targetType: AuditTargetType.USER,
        targetId: userId,
        metadata: {
          reason: reason || 'No reason provided',
          userEmail: user.email,
          userName: user.name,
          stellarAddress: user.stellarAddress,
          previousSuspensionReason: user.suspensionReason,
          suspendedAt: user.suspendedAt,
          wasScheduledUntil: user.suspendedUntil,
        },
        ipAddress,
      },
    });

    return updatedUser;
  }

  /**
   * Check if user account is active (not banned or suspended)
   * @param userId - User ID to check
   * @returns Object with status information
   */
  async checkAccountStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isBanned: true,
        bannedAt: true,
        banReason: true,
        isSuspended: true,
        suspendedAt: true,
        suspendedUntil: true,
        suspensionReason: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if suspension has expired
    if (user.isSuspended && user.suspendedUntil && user.suspendedUntil <= new Date()) {
      // Auto-unsuspend
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          isSuspended: false,
          suspendedAt: null,
          suspendedUntil: null,
          suspensionReason: null,
        },
      });

      return {
        isActive: true,
        isBanned: false,
        isSuspended: false,
      };
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
