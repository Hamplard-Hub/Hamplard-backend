import { NotificationType } from '@prisma/client';
import { LessonsService } from './lessons.service';

describe('LessonsService — Course Completion Notification & Summary (Issue #502)', () => {
  let service: LessonsService;

  const mockPrisma = {
    enrollment: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    lessonProgress: {
      upsert: jest.fn(),
      count: jest.fn(),
    },
  };
  const mockNotifications = {
    notifyUser: jest.fn(),
  };
  const mockCertificates = {
    issue: jest.fn().mockResolvedValue({ id: 'CERT-123' }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LessonsService(
      mockPrisma as any,
      mockNotifications as any,
      mockCertificates as any,
    );
  });

  const baseEnrollment = {
    id: 'enr-1',
    studentId: 'student-1',
    courseId: 'course-1',
    status: 'ACTIVE',
    student: { id: 'student-1', name: 'Amina Bello' },
    course: {
      id: 'course-1',
      title: 'Professional African Tailoring',
      instructor: { id: 'instructor-1', name: 'Master Chidi' },
      modules: [
        {
          id: 'mod-1',
          lessons: [
            { id: 'les-1', videoDuration: 300 },
            { id: 'les-2', videoDuration: 600 },
          ],
        },
      ],
    },
  };

  it('notifies both student and instructor with course summary and triggers certificate issuance when progress first reaches 100%', async () => {
    mockPrisma.enrollment.findUnique
      .mockResolvedValueOnce(baseEnrollment)
      .mockResolvedValueOnce(baseEnrollment);
    mockPrisma.lessonProgress.upsert.mockResolvedValueOnce({
      enrollmentId: 'enr-1',
      lessonId: 'les-2',
      completed: true,
    });
    mockPrisma.lessonProgress.count.mockResolvedValueOnce(2);
    mockPrisma.enrollment.update.mockResolvedValueOnce({
      ...baseEnrollment,
      status: 'COMPLETED',
      progressPercent: 100,
    });

    await service.markLessonComplete('student-1', 'enr-1', 'les-2', 600);

    expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(2);
    expect(mockNotifications.notifyUser).toHaveBeenNthCalledWith(
      1,
      'student-1',
      NotificationType.COURSE_COMPLETED,
      'Course Completed: Professional African Tailoring',
      expect.stringContaining('completed all 2 lessons across 1 modules'),
      expect.objectContaining({
        enrollmentId: 'enr-1',
        courseId: 'course-1',
        totalModules: 1,
        totalLessons: 2,
        completedLessons: 2,
        totalDurationSecs: 900,
      }),
    );
    expect(mockNotifications.notifyUser).toHaveBeenNthCalledWith(
      2,
      'instructor-1',
      NotificationType.COURSE_COMPLETED,
      'Student Completed Professional African Tailoring',
      expect.stringContaining('Amina Bello has completed 100%'),
      expect.objectContaining({
        enrollmentId: 'enr-1',
        courseId: 'course-1',
        studentId: 'student-1',
      }),
    );
    expect(mockCertificates.issue).toHaveBeenCalledWith(
      'instructor-1',
      'student-1',
      'course-1',
    );
  });

  it('does not send duplicate notifications when re-marking lessons on an already completed course', async () => {
    const completedEnrollment = {
      ...baseEnrollment,
      status: 'COMPLETED',
      progressPercent: 100,
    };
    mockPrisma.enrollment.findUnique
      .mockResolvedValueOnce(completedEnrollment)
      .mockResolvedValueOnce(completedEnrollment);
    mockPrisma.lessonProgress.upsert.mockResolvedValueOnce({
      enrollmentId: 'enr-1',
      lessonId: 'les-2',
      completed: true,
    });
    mockPrisma.lessonProgress.count.mockResolvedValueOnce(2);
    mockPrisma.enrollment.update.mockResolvedValueOnce(completedEnrollment);

    await service.markLessonComplete('student-1', 'enr-1', 'les-2', 600);

    expect(mockNotifications.notifyUser).not.toHaveBeenCalled();
    expect(mockCertificates.issue).not.toHaveBeenCalled();
  });
});
