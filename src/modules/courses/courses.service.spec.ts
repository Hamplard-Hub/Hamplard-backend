import { Test, TestingModule } from '@nestjs/testing';
import { CoursesService } from './courses.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FeeCalculatorService } from '../billing/fee-calculator.service';
import { SearchService } from '../search/search.service';
import { CacheService } from '../../common/cache/cache.service';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatus } from '@prisma/client';

const mockPrisma = {
  course: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    count:      jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    updateMany: jest.fn(),
    groupBy:    jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  enrollment: {
    findFirst: jest.fn(),
  },
  $getTransactionClient: jest.fn(),
  $transaction: jest.fn(),
};

const mockNotifications = {
  notifyUser: jest.fn().mockResolved({}),
};

const mockSearchService = {
  indexCourse: jest.fn().mockResolved(undefined),
  removeCourse: jest.fn().mockResolved(undefined),
  bulkIndexCourses: jest.fn().mockResolved(undefined),
  getIndexFreshness: jest.fn().mockResolved(0),
  search: jest.fn().mockResolved({
    hits: [], estimatedTotalHits: 0, page: 1, limit: 20, totalPages: 0, query: '', processingTimeMs: 0,
  }),
};

// In-memory stand-in so the spec never opens a Redis connection.
const mockCache = {
  buildKey: jest.fn((ns: string) => `cache:${ns} `),
  get: jest.fn().mockResolved(null),
  set: jest.fn().mockResolved(undefined),
  del: jest.fn().mockResolved(undefined),
  invalidateNamespace: jest.fn().mockResolved(undefined),
};

const MOCK_COURSE = {
  id:                'COURSE-TAILORING-001',
  instructorAddress: 'GABC',
  title:             'Professional Tailoring',
  category:          'Tailoring',
  level:             'Beginner',
  price:             50,
  platformFeePercent:20,
  status:            CourseStatus.ACTIVE,
  totalEnrollments:  0,
  totalRevenue:      0,
  createdAt:         new Date(),
  updatedAt:         new Date(),
  instructorId:       'instructor-id',
};

const PAID_LESSON = {
  id:          'lesson-paid',
  title:       'Paid Lesson',
  type:        'VIDEO',
  duration:     600,
  isFree:      false,
  videoUrl:    'https://example.com/paid.mp4',
  content:     'Secret paid content',
  resourceUrl: 'https://example.com/paid.pdf',
  order:       1,
  moduleId:    'module-1',
};

const FREE_LESSON = {
  id:          'lesson-free',
  title:       'Free Lesson',
  type:        'VIDEO',
  duration:     120,
  isFree:      true,
  videoUrl:    'https://example.com/free.mp4',
  content:     'Free preview content',
  resourceUrl: null,
  order:       1,
  moduleId:    'module-1',
};

describe('CoursesService', () => {
  let service: CoursesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoursesService,
        { provide: PrismaService,       useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: SearchService, useValue: mockSearchService },
        { provide: CacheService, useValue: mockCache },
        FeeCalculatorService,
      ],
    }).compile();

    service = module.get<CoursesService>(CoursesService);
    jest.clearAllMocks();
  });

  // -------------------------------------------------
  // CREATE
  // -------------------------------------------------

  describe('create()', () => {
    const dto = {
      courseId:    'COURSE-TAILORING-001',
      title:       'Professional Tailoring',
      category:    'Tailoring',
      price:       50,
      description: 'Learn tailoring from scratch',
    };

    it('creates a course draft successfully', async () => {
      mockPrisma.course.findUnique.mockResolved(null);
      mockPrisma.course.create.mockResolved({
        ...MOCK_COURSE,
        status: CourseStatus.DRAFT,
      });

      const result = await service.create('instructor-id', 'GABC', dto as any);
      expect(result.status).toBe(CourseStatus.DRAFT);
      expect(mockPrisma.course.create).toHaveBeenCalledTimes(1);
    });

    it('throws ConflictException if course ID already exists', async () => {
      mockPrisma.course.findUnique.mockResolved(MOCK_COURSE);
      await expect(service.create('instructor-id', 'GABC', dto as any))
        .rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------
  // APPROVE
  // -------------------------------------------------

  describe('approve()', () => {
    it('approves a pending course and notifies instructor', async () => {
      const pendingCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.PENDING,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolved(pendingCourse);
      mockPrisma.course.update.mockResolved({ ...pendingCourse, status: CourseStatus.ACTIVE });
      mockPrisma.user.findUnique.mockResolved({ id: 'user-1', email: 'instructor@test.com' });

      const result = await service.approve('COURSE-TAILORING-001', 'admin-id');
      expect(result.status).toBe(CourseStatus.ACTIVE);
      expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(1);
    });

    it('throws ForbiddenException if course is not pending', async () => {
      const activeCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.ACTIVE,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolved(activeCourse);
      await expect(service.approve('COURSE-TAILORING-001', 'admin-id'))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------
  // REJECT
  // -------------------------------------------------

  describe('reject()', () => {
    it('rejects a pending course and reverts to DRAFT', async () => {
      const pendingCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.PENDING,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolved(pendingCourse);
      mockPrisma.course.update.mockResolved({ ...pendingCourse, status: CourseStatus.DRAFT });
      mockPrisma.user.findUnique.mockResolved({ id: 'user-1', email: 'inst@test.com' });

      const result = await service.reject('COURSE-TAILORING-001', 'admin-id', 'Missing intro video');
      expect(result.status).toBe(CourseStatus.DRAFT);
      expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
        'user-1',
        'COURSE_REJECTED',
        expect.any(String),
        expect.stringContaining('Missing intro video'),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------
  // FIND ONE
  // -------------------------------------------------

  describe('findOne()', () => {
  const activeCourseWithCurriculum = () => ({
    ...MOCK_COURSE,
    modules: [
      {
        id: 'module-1',
        title: 'Introduction',
        order: 1,
        lessons: [{ ...FREE_LESSON }, { ...PAID_LESSON }],
      },
    ],
    _count: { enrollments: 5 },
    instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
  });

  it('returns course when found for owner', async () => {
    mockPrisma.course.findUnique.mockResolved(activeCourseWithCurriculum());

    const result = await service.findOne('COURSE-TAILORING-001', {
      userId: 'instructor-id',
      role: 'INSTRUCTOR',
    });
    expect(result.id).toBe('COURSE-TAILORING-001');
    expect(result._count.enrollments).toBe(5);
    // Owner sees full lesson content.
    const paid = result.modules[0].lessons[1] as any;
    expect(paid.videoUrl).toBe(PAID_LESSON.videoUrl);
    expect(paid.content).toBe(PAID_LESSON.content);
  });

  it('returns full view for admins', async () => {
    mockPrisma.course.findUnique.mockResolved(activeCourseWithCurriculum());

    const result = await service.findOne('COURSE-TAILORING-001', {
      userId: 'admin-id',
      role: 'ADMIN',
    });
    const paid = result.modules[0].lessons[1] as any;
    expect(paid.videoUrl).toBe(PAID_LESSON.videoUrl);
  });

  it('strips paid content for anonymous callers but keeps free content', async () => {
    mockPrisma.course.findUnique.mockResolved(activeCourseWithCurriculum());

    const result = await service.findOne('COURSE-TAILORING-001');
    const lessons = result.modules[0].lessons as any[];
    const free = lessons.find((l) => l.id === 'lesson-free');
    const paid = lessons.find((l) => l.id === 'lesson-paid');

    expect(free.content).toBe(FREE_LESSON.content);
    expect(free.videoUrl).toBe(FREE_LESSON.videoUrl);
    expect(paid.videoUrl).toBeUndefined();
    expect(paid.content).toBeUndefined();
    expect(paid.resourceUrl).toBeUndefined();
    // Outline metadata is still present.
    expect(paid.title).toBe(PAID_LESSON.title);
    expect(paid.type).toBe(PAID_LESSON.type);
    expect(paid.duration).toBe(PAID_LESSON.duration);
    expect(paid.isFree).toBe(false);
  });

  it('returns full content for enrolled callers', async () => {
    mockPrisma.course.findUnique.mockResolved(activeCourseWithCurriculum());
    mockPrisma.enrollment.findFirst.mockResolved({ studentId: 'student-1' });

    const result = await service.findOne('COURSE-TAILORING-001', {
      userId: 'student-1',
      role: 'STUDENT',
    });
    const paid = result.modules[0].lessons[1] as any;
    expect(paid.videoUrl).toBe(PAID_LESSON.videoUrl);
    expect(paid.content).toBe(PAID_LESSON.content);
  });

  it('throws NotFoundException when course not found', async () => {
    mockPrisma.course.findUnique.mockResolved(null);
    await expect(service.findOne('MISSING')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException for DRAFT courses to anonymous callers', async () => {
    mockPrisma.course.findUnique.mockResolved({
      ...activeCourseWithCurriculum(),
      status: CourseStatus.DRAFT,
    });
    await expect(service.findOne('COURSE-TAILORING-001')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException for PENDING courses to non-owners', async () => {
    mockPrisma.course.findUnique.mockResolved({
      ...activeCourseWithCurriculum(),
      status: CourseStatus.PENDING,
    });
    await expect(service.findOne('COURSE-TAILORING-001', {
      userId: 'someone-else',
      role: 'STUDENT',
    })).rejects.toThrow(NotFoundException);
  });

  it('returns full view for the owner of a non-ACTIVe course', async () => {
    mockPrisma.course.findUnique.mockResolved({
      ...activeCourseWithCurriculum(),
      status: CourseStatus.DRAFT,
    });
    const result = await service.findOne('COURSE-TAILORING-001', {
      userId: 'instructor-id',
      role: 'INSTRUCTOR',
    });
    expect(result.status).toBe(CourseStatus.DRAFT);
  });
});

  // -------------------------------------------------
  // FIND ALL
  // -------------------------------------------------

  describe('findAll()', () => {
    it('returns paginated active courses', async () => {
      const mockCourses = [MOCK_COURSE];
      mockPrisma.$transaction.mockResolved([mockCourses, 1]);

      const result = await service.findAll({ status: CourseStatus.ACTIVE });
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('applies category filter', async () => {
      mockPrisma.$transaction.mockResolved([[MOCK_COURSE], 1]);

      const result = await service.findAll({ category: 'Tailoring' });
      expect(result.data).toHaveLength(1);
    });
  });
});
