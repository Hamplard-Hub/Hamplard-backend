import { Test, TestingModule } from '@nestjs/testing';
import { LiveSessionsService } from './live-sessions.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { LiveSessionStatus } from '@prisma/client';

describe('LiveSessionsService', () => {
  let service: LiveSessionsService;
  let prisma: any;

  const mockPrisma = {
    course: { findUnique: jest.fn() },
    liveSession: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    enrollment: {
      findUnique: jest.fn(),
    },
    liveSessionRsvp: {
      create: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiveSessionsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<LiveSessionsService>(LiveSessionsService);
    prisma = module.get(PrismaService);
    jest.clearAllMocks();
  });

  it('should schedule a session when instructor is available', async () => {
    const user = { id: 'inst-1', stellarAddress: 'G_INST_1' };
    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'course-1',
      instructorAddress: 'G_INST_1',
      instructor: { id: 'inst-1' },
    });
    mockPrisma.liveSession.findMany.mockResolvedValue([]);
    mockPrisma.liveSession.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'sess-1', ...data }),
    );

    const result = await service.scheduleSession(user, {
      courseId: 'course-1',
      title: 'Live Workshop',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });

    expect(result.id).toBe('sess-1');
    expect(result.status).toBe(LiveSessionStatus.SCHEDULED);
  });

  it('should throw ConflictException if instructor has an overlapping session', async () => {
    const user = { id: 'inst-1', stellarAddress: 'G_INST_1' };
    const startTime = new Date(Date.now() + 86400000);

    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'course-1',
      instructorAddress: 'G_INST_1',
      instructor: { id: 'inst-1' },
    });
    mockPrisma.liveSession.findMany.mockResolvedValue([
      {
        id: 'sess-existing',
        title: 'Existing Session',
        scheduledAt: startTime,
        durationMinutes: 60,
        status: LiveSessionStatus.SCHEDULED,
      },
    ]);

    await expect(
      service.scheduleSession(user, {
        courseId: 'course-1',
        title: 'Conflicting Session',
        scheduledAt: startTime.toISOString(),
        durationMinutes: 60,
      }),
    ).rejects.toThrow(ConflictException);
  });

  describe('updateSession ownership check', () => {
    it('should throw ForbiddenException if user is neither course instructor id nor instructorAddress', async () => {
      mockPrisma.liveSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        instructorAddress: 'G_INST_1',
        course: {
          instructorAddress: 'G_INST_1',
          instructor: { id: 'inst-1' },
        },
      });

      const unauthorizedUser = { id: 'other-user', stellarAddress: 'G_OTHER' };

      await expect(
        service.updateSession(unauthorizedUser, 'sess-1', { title: 'New Title' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow update if user id matches course instructor id', async () => {
      const instructorUser = { id: 'inst-1', stellarAddress: 'G_OTHER' };
      mockPrisma.liveSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        title: 'Old Title',
        scheduledAt: new Date(),
        durationMinutes: 60,
        capacity: 50,
        status: LiveSessionStatus.SCHEDULED,
        course: {
          instructorAddress: 'G_INST_1',
          instructor: { id: 'inst-1' },
        },
      });
      mockPrisma.liveSession.update.mockResolvedValue({ id: 'sess-1', title: 'New Title' });

      const res = await service.updateSession(instructorUser, 'sess-1', { title: 'New Title' });
      expect(res.title).toBe('New Title');
    });
  });

  describe('rsvpToSession and cancelRsvp', () => {
    it('should throw ForbiddenException if student is not enrolled', async () => {
      mockPrisma.liveSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        courseId: 'course-1',
        capacity: 10,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.rsvpToSession({ id: 'student-1' }, 'sess-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ConflictException if session is at capacity', async () => {
      mockPrisma.liveSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        courseId: 'course-1',
        capacity: 2,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      mockPrisma.liveSessionRsvp.count.mockResolvedValue(2);

      await expect(
        service.rsvpToSession({ id: 'student-1' }, 'sess-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully create RSVP when enrolled and under capacity', async () => {
      mockPrisma.liveSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        courseId: 'course-1',
        capacity: 5,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ id: 'enr-1' });
      mockPrisma.liveSessionRsvp.count.mockResolvedValue(1);
      mockPrisma.liveSessionRsvp.create.mockResolvedValue({
        id: 'rsvp-1',
        sessionId: 'sess-1',
        studentId: 'student-1',
      });

      const res = await service.rsvpToSession({ id: 'student-1' }, 'sess-1');
      expect(res.id).toBe('rsvp-1');
    });

    it('should cancel RSVP successfully', async () => {
      mockPrisma.liveSession.findUnique.mockResolvedValue({ id: 'sess-1' });
      mockPrisma.liveSessionRsvp.findUnique.mockResolvedValue({ id: 'rsvp-1' });
      mockPrisma.liveSessionRsvp.delete.mockResolvedValue({ id: 'rsvp-1' });

      const res = await service.cancelRsvp({ id: 'student-1' }, 'sess-1');
      expect(res.id).toBe('rsvp-1');
    });
  });
});
