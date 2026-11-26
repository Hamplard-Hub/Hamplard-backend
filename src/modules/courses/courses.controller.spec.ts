import { Test, TestingModule } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { CourseStatus, UserRole } from '@prisma/client';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { CacheService } from '../../common/cache/cache.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';

/**
 * Stand-in for JwtAuthGuard: authenticates from an `x-test-role` header so the
 * real RolesGuard still decides who may reach admin routes.
 */
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const role = req.headers['x-test-role'];
    if (!role) return false;
    req.user = { id: `${role}-id`, role };
    return true;
  }
}

describe('CoursesController (HTTP)', () => {
  let app: INestApplication;

  const mockCoursesService = {
    findAll: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [
        { provide: CoursesService, useValue: mockCoursesService },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), buildKey: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard).useClass(HeaderAuthGuard)
      .overrideGuard(OptionalJwtAuthGuard).useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Mirrors the global pipe configured in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCoursesService.findAll.mockResolvedValue({
      data: [],
      meta: { total: 45, page: 2, limit: 20, totalPages: 3 },
    });
  });

  describe('GET /courses/admin/pending (issue #445)', () => {
    it('defaults to page 1 / limit 20, PENDING only, oldest first', async () => {
      const res = await request(app.getHttpServer())
        .get('/courses/admin/pending')
        .set('x-test-role', UserRole.ADMIN);

      expect(res.status).toBe(200);
      expect(mockCoursesService.findAll).toHaveBeenCalledWith({
        status: CourseStatus.PENDING,
        page: 1,
        limit: 20,
        sortOrder: 'asc',
      });
    });

    it('passes page/limit through and returns pagination meta', async () => {
      const res = await request(app.getHttpServer())
        .get('/courses/admin/pending?page=2&limit=20')
        .set('x-test-role', UserRole.ADMIN);

      expect(res.status).toBe(200);
      expect(mockCoursesService.findAll).toHaveBeenCalledWith({
        status: CourseStatus.PENDING,
        page: 2,
        limit: 20,
        sortOrder: 'asc',
      });
      expect(res.body.meta).toEqual({ total: 45, page: 2, limit: 20, totalPages: 3 });
    });

    it('cannot override the PENDING filter via query parameters', async () => {
      const res = await request(app.getHttpServer())
        .get('/courses/admin/pending?status=ACTIVE')
        .set('x-test-role', UserRole.ADMIN);

      expect(res.status).toBe(400);
      expect(mockCoursesService.findAll).not.toHaveBeenCalled();
    });

    it.each(['limit=101', 'limit=0', 'page=0', 'page=abc'])(
      'rejects invalid pagination (%s) with 400',
      async (qs) => {
        const res = await request(app.getHttpServer())
          .get(`/courses/admin/pending?${qs}`)
          .set('x-test-role', UserRole.ADMIN);

        expect(res.status).toBe(400);
        expect(mockCoursesService.findAll).not.toHaveBeenCalled();
      },
    );

    it('forbids non-admin callers', async () => {
      const res = await request(app.getHttpServer())
        .get('/courses/admin/pending')
        .set('x-test-role', UserRole.INSTRUCTOR);

      expect(res.status).toBe(403);
      expect(mockCoursesService.findAll).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated callers', async () => {
      const res = await request(app.getHttpServer()).get('/courses/admin/pending');

      expect(res.status).toBe(403);
      expect(mockCoursesService.findAll).not.toHaveBeenCalled();
    });
  });
});
