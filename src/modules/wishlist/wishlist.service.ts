import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CourseStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WishlistService {
  private readonly logger = new Logger(WishlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Add a course to a student's wishlist.
   * Validates that the course exists and is ACTIVE, and prevents
   * duplicate entries (enforced here and by the DB unique constraint).
   * Idempotent — adding an already-saved course returns the existing item.
   */
  async add(studentId: string, courseId: string) {
    if (!courseId) throw new BadRequestException('courseId is required');

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, status: CourseStatus.ACTIVE },
      select: { id: true, title: true },
    });
    if (!course) {
      throw new NotFoundException(`Course ${courseId} not found or not active`);
    }

    const existing = await this.prisma.wishlistItem.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (existing) {
      return {
        item: existing,
        alreadySaved: true,
        message: 'Course already in wishlist',
      };
    }

    const item = await this.prisma.wishlistItem.create({
      data: { studentId, courseId },
      include: { course: true },
    });

    this.logger.log(`Wishlist item added: ${studentId} → ${courseId}`);
    return { item, alreadySaved: false, message: 'Course added to wishlist' };
  }

  /**
   * Remove a course from a student's wishlist.
   */
  async remove(studentId: string, courseId: string) {
    if (!courseId) throw new BadRequestException('courseId is required');

    const existing = await this.prisma.wishlistItem.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (!existing) {
      throw new NotFoundException('Course not found in wishlist');
    }

    await this.prisma.wishlistItem.delete({ where: { id: existing.id } });

    this.logger.log(`Wishlist item removed: ${studentId} → ${courseId}`);
    return { message: 'Course removed from wishlist' };
  }

  /**
   * List the student's wishlist with course details, newest first.
   */
  async findAll(studentId: string, page = 1, limit = 20) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.wishlistItem.findMany({
        where: { studentId },
        include: {
          course: {
            include: { instructor: { select: { name: true, avatarUrl: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.wishlistItem.count({ where: { studentId } }),
    ]);

    return { data: items, meta: { total, page, limit } };
  }
}
