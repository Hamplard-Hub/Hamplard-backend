// users.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

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
    const totalRevenue  = courses.reduce((s, c) => s + Number(c.totalRevenue), 0);

    return { totalCourses: courses.length, totalStudents, totalRevenue, courses };
  }
}
