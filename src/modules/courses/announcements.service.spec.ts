import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { CoursesService } from './courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { QueueService } from '../../common/queue/queue.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let queue: QueueService;

  const mockCourse = {
    id: 'course-123',
    instructorAddress: 'instructor-addr',
    title: 'Test Course',
  };

  const mockOwner = {
    id: 'user-123',
    stellarAddress: 'instructor-addr',
    role: 'INSTRUCTOR',
  };

  const mockAdmin = {
    id: 'admin-123',
    stellarAddress: 'admin-addr',
    role: 'ADMIN',
  };

  const mockStudent = {
    id: 'student-1',
    role: 'STUDENT',
  };

  const mockAnnouncement = {
    id: 'announce-123',
    courseId: 'course-123',
    createdById: 'user-123',
    title: 'Important Update',
    content: 'This is an important announcement.',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: {
      id: 'user-123',
      name: 'John Instructor',
      email: 'john@example.com',
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementsService,
        {
          provide: PrismaService,
          useValue: {
            course: { findUnique: jest.fn() },
            announcement: {
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            enrollment: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            notifyUser: jest.fn(),
          },
        },
        {
          provide: QueueService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<AnnouncementsService>(AnnouncementsService);
    prisma = module.get<PrismaService>(PrismaService);
    notifications = module.get<NotificationsService>(NotificationsService);
    queue = module.get<QueueService>(QueueService);
  });

  describe('createAnnouncement', () => {
    it('should create an announcement and queue notifications', async () => {
      const dto = {
        title: 'Important Update',
        content: 'This is an important announcement.',
      };

      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.announcement.count as jest.Mock).mockResolvedValue(0);
      (prisma.announcement.create as jest.Mock).mockResolvedValue(mockAnnouncement);
      (prisma.enrollment.findMany as jest.Mock).mockResolvedValue([
        { studentId: 'student-1' },
        { studentId: 'student-2' },
      ]);
      (notifications.notifyUser as jest.Mock).mockResolvedValue({});

      const result = await service.createAnnouncement('course-123', mockOwner as any, dto);

      expect(result).toEqual(mockAnnouncement);
      expect(prisma.announcement.create).toHaveBeenCalledWith({
        data: {
          courseId: 'course-123',
          createdById: 'user-123',
          title: dto.title,
          content: dto.content,
        },
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
        },
      });
      expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
    });

    it('should throw NotFoundException if course does not exist', async () => {
      const dto = {
        title: 'Important Update',
        content: 'This is an important announcement.',
      };

      (prisma.course.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createAnnouncement('nonexistent', mockOwner as any, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if user is not course owner', async () => {
      const dto = {
        title: 'Important Update',
        content: 'This is an important announcement.',
      };

      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);

      await expect(
        service.createAnnouncement('course-123', mockStudent as any, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow admin to create announcements', async () => {
      const dto = {
        title: 'Important Update',
        content: 'This is an important announcement.',
      };

      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.announcement.count as jest.Mock).mockResolvedValue(0);
      (prisma.announcement.create as jest.Mock).mockResolvedValue(mockAnnouncement);
      (prisma.enrollment.findMany as jest.Mock).mockResolvedValue([]);
      (notifications.notifyUser as jest.Mock).mockResolvedValue({});

      const result = await service.createAnnouncement('course-123', mockAdmin as any, dto);

      expect(result).toEqual(mockAnnouncement);
      expect(prisma.announcement.create).toHaveBeenCalled();
    });

    it('should throw BadRequestException when rate limit is exceeded', async () => {
      const dto = {
        title: 'Important Update',
        content: 'This is an important announcement.',
      };

      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.announcement.count as jest.Mock).mockResolvedValue(100);

      await expect(
        service.createAnnouncement('course-123', mockOwner as any, dto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getAnnouncementsForCourse', () => {
    it('should return announcements for enrolled students', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.enrollment.findUnique as jest.Mock).mockResolvedValue({ id: 'enrollment-1' });
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        [mockAnnouncement],
        1,
      ]);

      const result = await service.getAnnouncementsForCourse(
        'course-123',
        1,
        20,
        'student-1',
        'STUDENT',
      );

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(20);
    });

    it('should return announcements for course owner', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        [mockAnnouncement],
        1,
      ]);

      const result = await service.getAnnouncementsForCourse(
        'course-123',
        1,
        20,
        'instructor-addr',
        'INSTRUCTOR',
      );

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should return announcements for admin', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        [mockAnnouncement],
        1,
      ]);

      const result = await service.getAnnouncementsForCourse(
        'course-123',
        1,
        20,
        'admin-123',
        'ADMIN',
      );

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should throw ForbiddenException for non-enrolled student', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.enrollment.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getAnnouncementsForCourse('course-123', 1, 20, 'student-2', 'STUDENT'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if course does not exist', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getAnnouncementsForCourse('nonexistent', 1, 20),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow unauthenticated users to see announcements', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        [mockAnnouncement],
        1,
      ]);

      const result = await service.getAnnouncementsForCourse('course-123', 1, 20);

      expect(result.data).toHaveLength(1);
    });

    it('should respect pagination parameters', async () => {
      (prisma.course.findUnique as jest.Mock).mockResolvedValue(mockCourse);
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        [mockAnnouncement],
        50,
      ]);

      const result = await service.getAnnouncementsForCourse(
        'course-123',
        2,
        10,
      );

      expect(result.meta.page).toBe(2);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.total).toBe(50);
    });
  });
});
