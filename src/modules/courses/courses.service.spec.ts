import { Test, TestingModule } from '@nestjs/testing';
import { CoursesService } from './courses.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FeeCalculatorService } from '../billing/fee-calculator.service';
import { SearchService } from '../search/search.service';
import { CacheService } from '../../common/cache/cache.service';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatus, UserRole } from '@prisma/client';

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
  coursePrerequisite: {
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    delete:     jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

// Request users as attached by JwtStrategy (issue #241)
const OWNER    = { id: 'instructor-id', stellarAddress: 'GABC',  role: UserRole.INSTRUCTOR };
const NON_OWNER = { id: 'intruder-id',  stellarAddress: 'GXYZ',  role: UserRole.INSTRUCTOR };
const ADMIN    = { id: 'admin-id',      stellarAddress: 'GADMIN', role: UserRole.ADMIN };

const mockNotifications = {
  notifyUser: jest.fn().mockResolvedValue({}),
};

const mockSearchService = {
  indexCourse: jest.fn().mockResolvedValue(undefined),
  removeCourse: jest.fn().mockResolvedValue(undefined),
  bulkIndexCourses: jest.fn().mockResolvedValue(undefined),
  getIndexFreshness: jest.fn().mockResolvedValue(0),
  search: jest.fn().mockResolvedValue({
    hits: [], estimatedTotalHits: 0, page: 1, limit: 20, totalPages: 0, query: '', processingTimeMs: 0,
  }),
};

// In-memory stand-in so the spec never opens a Redis connection.
const mockCache = {
  buildKey: jest.fn((ns: string) => `cache:${ns}`),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
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

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  describe('create()', () => {
    const dto = {
      courseId:    'COURSE-TAILORING-001',
      title:       'Professional Tailoring',
      category:    'Tailoring',
      price:       50,
      description: 'Learn tailoring from scratch',
    };

    it('creates a course draft successfully', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);
      mockPrisma.course.create.mockResolvedValue({
        ...MOCK_COURSE,
        status: CourseStatus.DRAFT,
      });

      const result = await service.create('instructor-id', 'GABC', dto as any);
      expect(result.status).toBe(CourseStatus.DRAFT);
      expect(mockPrisma.course.create).toHaveBeenCalledTimes(1);
    });

    it('throws ConflictException if course ID already exists', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(MOCK_COURSE);
      await expect(service.create('instructor-id', 'GABC', dto as any))
        .rejects.toThrow(ConflictException);
    });
  });

  // ----------------------------------------------------------
  // APPROVE
  // ----------------------------------------------------------

  describe('approve()', () => {
    it('approves a pending course and notifies instructor', async () => {
      const pendingCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.PENDING,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolvedValue(pendingCourse);
      mockPrisma.course.update.mockResolvedValue({ ...pendingCourse, status: CourseStatus.ACTIVE });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'instructor@test.com' });

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
      mockPrisma.course.findUnique.mockResolvedValue(activeCourse);
      await expect(service.approve('COURSE-TAILORING-001', 'admin-id'))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ----------------------------------------------------------
  // REJECT
  // ----------------------------------------------------------

  describe('reject()', () => {
    it('rejects a pending course and reverts to DRAFT', async () => {
      const pendingCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.PENDING,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolvedValue(pendingCourse);
      mockPrisma.course.update.mockResolvedValue({ ...pendingCourse, status: CourseStatus.DRAFT });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'inst@test.com' });

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

  // ----------------------------------------------------------
  // FIND ONE
  // ----------------------------------------------------------

  describe('findOne()', () => {
    it('returns course when found', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        ...MOCK_COURSE,
        modules: [],
        _count: { enrollments: 5 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      });

      const result = await service.findOne('COURSE-TAILORING-001');
      expect(result.id).toBe('COURSE-TAILORING-001');
      expect(result._count.enrollments).toBe(5);
    });

    it('throws NotFoundException when course not found', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);
      await expect(service.findOne('MISSING')).rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------
  // FIND ALL
  // ----------------------------------------------------------

  describe('findAll()', () => {
    it('returns paginated active courses', async () => {
      const mockCourses = [MOCK_COURSE];
      mockPrisma.$transaction.mockResolvedValue([mockCourses, 1]);

      const result = await service.findAll({ status: CourseStatus.ACTIVE });
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('applies category filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);
      await service.findAll({ category: 'Baking', status: CourseStatus.ACTIVE });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------
  // SUBMIT FOR REVIEW
  // ----------------------------------------------------------

  describe('submitForReview()', () => {
    it('moves a DRAFT course to PENDING', async () => {
      const draftCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.DRAFT,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolvedValue(draftCourse);
      mockPrisma.course.update.mockResolvedValue({ ...draftCourse, status: CourseStatus.PENDING });

      const result = await service.submitForReview(
        'COURSE-TAILORING-001', OWNER, 'tx-hash-abc',
      );
      expect(result.status).toBe(CourseStatus.PENDING);
    });

    it('throws ForbiddenException if course is not a DRAFT', async () => {
      const pendingCourse = {
        ...MOCK_COURSE,
        status: CourseStatus.PENDING,
        modules: [],
        _count: { enrollments: 0 },
        instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
      };
      mockPrisma.course.findUnique.mockResolvedValue(pendingCourse);
      await expect(service.submitForReview('COURSE-TAILORING-001', OWNER))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ----------------------------------------------------------
  // GET CATEGORIES
  // ----------------------------------------------------------

  describe('getCategories()', () => {
    it('returns category list with counts', async () => {
      mockPrisma.course.groupBy.mockResolvedValue([
        { category: 'Tailoring', _count: { category: 5 } },
        { category: 'Makeup',    _count: { category: 3 } },
        { category: 'Baking',    _count: { category: 7 } },
      ]);

      const result = await service.getCategories();
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'Tailoring', count: 5 });
    });
  });

  // ----------------------------------------------------------
  // COURSE OWNERSHIP (issue #241)
  // ----------------------------------------------------------

  describe('course ownership enforcement', () => {
    const fullCourse = (status: CourseStatus) => ({
      ...MOCK_COURSE,
      status,
      modules: [],
      _count: { enrollments: 0 },
      instructor: { name: 'John', stellarAddress: 'GABC', avatarUrl: null, bio: null },
    });

    describe('assertCourseOwner()', () => {
      it('allows the instructor whose stellarAddress matches', () => {
        expect(() => service.assertCourseOwner(MOCK_COURSE, OWNER)).not.toThrow();
      });

      it('allows an ADMIN who does not own the course', () => {
        expect(() => service.assertCourseOwner(MOCK_COURSE, ADMIN)).not.toThrow();
      });

      it('throws ForbiddenException for a non-owner instructor', () => {
        expect(() => service.assertCourseOwner(MOCK_COURSE, NON_OWNER))
          .toThrow(ForbiddenException);
      });

      it('does not treat a missing stellarAddress as a match', () => {
        const noWallet = { id: 'someone', stellarAddress: null, role: UserRole.INSTRUCTOR };
        expect(() => service.assertCourseOwner({ instructorAddress: '' }, noWallet))
          .toThrow(ForbiddenException);
      });
    });

    describe('update()', () => {
      beforeEach(() => {
        mockPrisma.course.findUnique.mockResolvedValue(fullCourse(CourseStatus.DRAFT));
        mockPrisma.course.update.mockResolvedValue({ ...MOCK_COURSE, status: CourseStatus.DRAFT });
      });

      it('returns 403 for a non-owner instructor and does not write', async () => {
        await expect(service.update(MOCK_COURSE.id, NON_OWNER, { title: 'Hijacked' } as any))
          .rejects.toThrow(ForbiddenException);
        expect(mockPrisma.course.update).not.toHaveBeenCalled();
      });

      it.each([['owner', OWNER], ['admin', ADMIN]])('succeeds for the %s', async (_label, user) => {
        await service.update(MOCK_COURSE.id, user, { title: 'New title' } as any);
        expect(mockPrisma.course.update).toHaveBeenCalledWith({
          where: { id: MOCK_COURSE.id },
          data: { title: 'New title' },
        });
      });
    });

    describe('submitForReview()', () => {
      beforeEach(() => {
        mockPrisma.course.findUnique.mockResolvedValue(fullCourse(CourseStatus.DRAFT));
        mockPrisma.course.update.mockResolvedValue({ ...MOCK_COURSE, status: CourseStatus.PENDING });
      });

      it('returns 403 for a non-owner instructor and does not write', async () => {
        await expect(service.submitForReview(MOCK_COURSE.id, NON_OWNER))
          .rejects.toThrow(ForbiddenException);
        expect(mockPrisma.course.update).not.toHaveBeenCalled();
      });

      it.each([['owner', OWNER], ['admin', ADMIN]])('succeeds for the %s', async (_label, user) => {
        const result = await service.submitForReview(MOCK_COURSE.id, user);
        expect(result.status).toBe(CourseStatus.PENDING);
      });
    });

    describe('setPrerequisites()', () => {
      beforeEach(() => {
        mockPrisma.course.findUnique.mockResolvedValue(fullCourse(CourseStatus.ACTIVE));
        mockPrisma.coursePrerequisite.findMany.mockResolvedValue([]);
        mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
      });

      it('returns 403 for a non-owner instructor and does not write', async () => {
        await expect(service.setPrerequisites(MOCK_COURSE.id, NON_OWNER, { prerequisiteIds: [] }))
          .rejects.toThrow(ForbiddenException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it.each([['owner', OWNER], ['admin', ADMIN]])('succeeds for the %s', async (_label, user) => {
        await expect(service.setPrerequisites(MOCK_COURSE.id, user, { prerequisiteIds: [] }))
          .resolves.toEqual([]);
        expect(mockPrisma.coursePrerequisite.deleteMany).toHaveBeenCalledWith({
          where: { courseId: MOCK_COURSE.id },
        });
      });
    });

    describe('removePrerequisite()', () => {
      beforeEach(() => {
        mockPrisma.course.findUnique.mockResolvedValue(fullCourse(CourseStatus.ACTIVE));
        mockPrisma.coursePrerequisite.findUnique.mockResolvedValue({ id: 'link-1' });
        mockPrisma.coursePrerequisite.delete.mockResolvedValue({ id: 'link-1' });
      });

      it('returns 403 for a non-owner instructor and does not delete', async () => {
        await expect(service.removePrerequisite(MOCK_COURSE.id, NON_OWNER, 'PREREQ-1'))
          .rejects.toThrow(ForbiddenException);
        expect(mockPrisma.coursePrerequisite.delete).not.toHaveBeenCalled();
      });

      it.each([['owner', OWNER], ['admin', ADMIN]])('succeeds for the %s', async (_label, user) => {
        await expect(service.removePrerequisite(MOCK_COURSE.id, user, 'PREREQ-1'))
          .resolves.toEqual({ message: 'Prerequisite removed successfully' });
        expect(mockPrisma.coursePrerequisite.delete).toHaveBeenCalledWith({ where: { id: 'link-1' } });
      });
    });
  });
});
