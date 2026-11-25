import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { LessonsService } from './lessons.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CdnService } from '../uploads/cdn.service';

describe('LessonsService (Ownership & IDOR Protection)', () => {
  let service: LessonsService;
  const mockAnalytics = { trackEvent: jest.fn().mockResolvedValue({}) };
  const mockCdn = { signLessonMediaUrl: jest.fn() };

  const mockPrisma = {
    course: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    courseModule: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    lesson: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    enrollment: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    lessonProgress: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LessonsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AnalyticsService, useValue: mockAnalytics },
        { provide: CdnService, useValue: mockCdn },
      ],
    }).compile();

    service = module.get<LessonsService>(LessonsService);
    jest.clearAllMocks();
  });

  describe('createModule()', () => {
    it('throws NotFoundException when target course does not exist', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(
        service.createModule('course-999', 'Intro', 1, {
          id: 'instructor-1',
          stellarAddress: 'GINSTRUCTOR1',
          role: UserRole.INSTRUCTOR,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when an instructor attempts to add a module to another instructor course', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        instructorAddress: 'GOTHER_INSTRUCTOR',
        instructor: { id: 'other-instructor' },
      });

      await expect(
        service.createModule('course-1', 'Intro', 1, {
          id: 'instructor-1',
          stellarAddress: 'GINSTRUCTOR1',
          role: UserRole.INSTRUCTOR,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows the course owner instructor to create a module', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        instructorAddress: 'GINSTRUCTOR1',
        instructor: { id: 'instructor-1' },
      });
      mockPrisma.courseModule.create.mockResolvedValue({
        id: 'mod-1',
        courseId: 'course-1',
        title: 'Intro',
        position: 1,
      });

      const result = await service.createModule('course-1', 'Intro', 1, {
        id: 'instructor-1',
        stellarAddress: 'GINSTRUCTOR1',
        role: UserRole.INSTRUCTOR,
      });

      expect(result.id).toBe('mod-1');
      expect(mockPrisma.courseModule.create).toHaveBeenCalledWith({
        data: { courseId: 'course-1', title: 'Intro', position: 1 },
      });
    });

    it('allows an ADMIN to create a module for any course', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        instructorAddress: 'GOTHER_INSTRUCTOR',
        instructor: { id: 'other-instructor' },
      });
      mockPrisma.courseModule.create.mockResolvedValue({
        id: 'mod-1',
        courseId: 'course-1',
        title: 'Admin Module',
        position: 1,
      });

      const result = await service.createModule('course-1', 'Admin Module', 1, {
        id: 'admin-1',
        stellarAddress: 'GADMIN',
        role: UserRole.ADMIN,
      });

      expect(result.id).toBe('mod-1');
      expect(mockPrisma.courseModule.create).toHaveBeenCalled();
    });
  });

  describe('createLesson()', () => {
    it('throws NotFoundException when target module does not exist', async () => {
      mockPrisma.courseModule.findUnique.mockResolvedValue(null);

      await expect(
        service.createLesson(
          'mod-999',
          { title: 'Lesson 1', position: 1 },
          { id: 'instructor-1', stellarAddress: 'GINSTRUCTOR1', role: UserRole.INSTRUCTOR },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when an instructor attempts to add a lesson to another instructor module', async () => {
      mockPrisma.courseModule.findUnique.mockResolvedValue({
        id: 'mod-1',
        courseId: 'course-1',
        course: {
          id: 'course-1',
          instructorAddress: 'GOTHER_INSTRUCTOR',
          instructor: { id: 'other-instructor' },
        },
      });

      await expect(
        service.createLesson(
          'mod-1',
          { title: 'Lesson 1', position: 1 },
          { id: 'instructor-1', stellarAddress: 'GINSTRUCTOR1', role: UserRole.INSTRUCTOR },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows module course owner to create a lesson and updates totalLessons', async () => {
      mockPrisma.courseModule.findUnique.mockResolvedValue({
        id: 'mod-1',
        courseId: 'course-1',
        course: {
          id: 'course-1',
          instructorAddress: 'GINSTRUCTOR1',
          instructor: { id: 'instructor-1' },
        },
      });
      mockPrisma.lesson.create.mockResolvedValue({
        id: 'lesson-1',
        moduleId: 'mod-1',
        title: 'Lesson 1',
        position: 1,
      });
      mockPrisma.course.update.mockResolvedValue({});

      const result = await service.createLesson(
        'mod-1',
        { title: 'Lesson 1', position: 1 },
        { id: 'instructor-1', stellarAddress: 'GINSTRUCTOR1', role: UserRole.INSTRUCTOR },
      );

      expect(result.id).toBe('lesson-1');
      expect(mockPrisma.course.update).toHaveBeenCalledWith({
        where: { id: 'course-1' },
        data: { totalLessons: { increment: 1 } },
      });
    });
  });

  describe('markLessonComplete() IDOR check', () => {
    it('throws NotFoundException if enrollment does not exist', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.markLessonComplete('student-1', 'enrollment-999', 'lesson-1', 120),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if enrollment belongs to another student', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        studentId: 'other-student',
        course: { modules: [{ lessons: [{ id: 'lesson-1' }] }] },
      });

      await expect(
        service.markLessonComplete('student-1', 'enrollment-1', 'lesson-1', 120),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException if lesson does not belong to the enrolled course', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        studentId: 'student-1',
        course: { modules: [{ lessons: [{ id: 'other-course-lesson' }] }] },
      });

      await expect(
        service.markLessonComplete('student-1', 'enrollment-1', 'lesson-1', 120),
      ).rejects.toThrow(BadRequestException);
    });

    it('successfully records lesson complete when called by the enrolled student', async () => {
      mockPrisma.enrollment.findUnique
        .mockResolvedValueOnce({
          id: 'enrollment-1',
          studentId: 'student-1',
          course: {
            modules: [
              {
                lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          id: 'enrollment-1',
          studentId: 'student-1',
          course: {
            modules: [
              {
                lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }],
              },
            ],
          },
        });

      mockPrisma.lessonProgress.upsert.mockResolvedValue({
        id: 'lp-1',
        enrollmentId: 'enrollment-1',
        lessonId: 'lesson-1',
        completed: true,
      });
      mockPrisma.lessonProgress.count.mockResolvedValue(1);
      mockPrisma.enrollment.update.mockResolvedValue({});

      const result = await service.markLessonComplete(
        'student-1',
        'enrollment-1',
        'lesson-1',
        300,
      );

      expect(result.completed).toBe(true);
      expect(mockPrisma.lessonProgress.upsert).toHaveBeenCalled();
      expect(mockAnalytics.trackEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'lesson_completed' }),
        { userId: 'student-1', source: 'server' },
      );
    });
  });

  describe('updateWatchProgress() IDOR check', () => {
    it('throws ForbiddenException if enrollment belongs to another student', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        studentId: 'other-student',
        course: { modules: [{ lessons: [{ id: 'lesson-1' }] }] },
      });

      await expect(
        service.updateWatchProgress('student-1', 'enrollment-1', 'lesson-1', 45),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException if lesson does not belong to the enrolled course', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        studentId: 'student-1',
        course: { modules: [{ lessons: [{ id: 'different-lesson' }] }] },
      });

      await expect(
        service.updateWatchProgress('student-1', 'enrollment-1', 'lesson-1', 45),
      ).rejects.toThrow(BadRequestException);
    });

    it('successfully updates watch progress when called by owner student', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        id: 'enrollment-1',
        studentId: 'student-1',
        course: { modules: [{ lessons: [{ id: 'lesson-1' }] }] },
      });

      mockPrisma.lessonProgress.upsert.mockResolvedValue({
        id: 'lp-1',
        enrollmentId: 'enrollment-1',
        lessonId: 'lesson-1',
        watchedSecs: 45,
      });

      const result = await service.updateWatchProgress(
        'student-1',
        'enrollment-1',
        'lesson-1',
        45,
      );

      expect(result.watchedSecs).toBe(45);
      expect(mockPrisma.lessonProgress.upsert).toHaveBeenCalledWith({
        where: { enrollmentId_lessonId: { enrollmentId: 'enrollment-1', lessonId: 'lesson-1' } },
        create: { enrollmentId: 'enrollment-1', lessonId: 'lesson-1', watchedSecs: 45 },
        update: { watchedSecs: 45 },
      });
    });
  });

  describe('updateThumbnailUrl() (issue #436)', () => {
    const lessonWithCourse = {
      id: 'lesson-1',
      module: {
        course: {
          id: 'course-1',
          instructorAddress: 'GINSTRUCTOR1',
          instructor: { id: 'instructor-1' },
        },
      },
    };

    it('rejects an instructor who does not own the lesson course', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lessonWithCourse);

      await expect(
        service.updateThumbnailUrl('lesson-1', 'https://cdn.example.com/t.jpg', {
          id: 'other-instructor',
          stellarAddress: 'GOTHER',
          role: UserRole.INSTRUCTOR,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.lesson.update).not.toHaveBeenCalled();
    });

    it('allows the course owner to update the thumbnail', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lessonWithCourse);
      mockPrisma.lesson.update.mockResolvedValue({ id: 'lesson-1' });

      await service.updateThumbnailUrl('lesson-1', 'https://cdn.example.com/t.jpg', {
        id: 'instructor-1',
        stellarAddress: 'GINSTRUCTOR1',
        role: UserRole.INSTRUCTOR,
      });

      expect(mockPrisma.lesson.update).toHaveBeenCalledWith({
        where: { id: 'lesson-1' },
        data: { thumbnailUrl: 'https://cdn.example.com/t.jpg' },
      });
    });

    it('allows an admin to update any lesson thumbnail', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lessonWithCourse);
      mockPrisma.lesson.update.mockResolvedValue({ id: 'lesson-1' });

      await service.updateThumbnailUrl('lesson-1', 'https://cdn.example.com/t.jpg', {
        id: 'admin-1',
        role: UserRole.ADMIN,
      });

      expect(mockPrisma.lesson.update).toHaveBeenCalled();
  /** Issue #335 — students only ever receive short-lived signed video URLs. */
  describe('findLessonForViewer()', () => {
    it('replaces the stored videoUrl with a signed URL and its expiry', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({
        id: 'lesson-1',
        videoUrl: '/uploads/courses/c1/lessons/lesson-1/video.mp4',
        module: { course: { id: 'c1' } },
      });
      mockCdn.signLessonMediaUrl.mockReturnValue({
        url: 'https://cdn.hamplard.com/uploads/courses/c1/lessons/lesson-1/video.mp4?expires=1&signature=abc',
        expiresAt: '2026-11-24T10:05:00.000Z',
      });

      const lesson = await service.findLessonForViewer('lesson-1');

      expect(mockCdn.signLessonMediaUrl).toHaveBeenCalledWith('/uploads/courses/c1/lessons/lesson-1/video.mp4');
      expect(lesson.videoUrl).toContain('signature=abc');
      expect(lesson.videoUrlExpiresAt).toBe('2026-11-24T10:05:00.000Z');
    });

    it('returns null video fields for lessons without a video', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({ id: 'lesson-2', videoUrl: null, module: {} });
      mockCdn.signLessonMediaUrl.mockReturnValue(null);

      const lesson = await service.findLessonForViewer('lesson-2');

      expect(lesson.videoUrl).toBeNull();
      expect(lesson.videoUrlExpiresAt).toBeNull();
    });

    it('throws NotFoundException for an unknown lesson', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.findLessonForViewer('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
