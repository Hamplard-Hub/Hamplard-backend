import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { Reflector } from '@nestjs/core';
import { CoursesController } from '../../modules/courses/courses.controller';
import { CoursesService } from '../../modules/courses/courses.service';
import { CacheService } from '../../common/cache/cache.service';
import { CourseStatus } from '@prisma/client';

describe('Pagination Validation Integration (Global ValidationPipe)', () => {
  let app: INestApplication;

  const mockCoursesService = {
    findAll: jest.fn().mockResolvedValue({
      courses: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    }),
  };

  const mockCacheService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    buildKey: jest.fn().mockReturnValue('courses:list:test'),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CoursesController],
      providers: [
        { provide: CoursesService, useValue: mockCoursesService },
        { provide: CacheService, useValue: mockCacheService },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts valid pagination parameters', async () => {
    const res = await request(app.getHttpServer()).get('/courses?page=2&limit=50');
    expect(res.status).toBe(200);
    expect(mockCoursesService.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 50,
        status: CourseStatus.ACTIVE,
      }),
    );
  });

  it('accepts boundary limit values (limit=1 and limit=100)', async () => {
    const res1 = await request(app.getHttpServer()).get('/courses?page=1&limit=1');
    expect(res1.status).toBe(200);

    const res100 = await request(app.getHttpServer()).get('/courses?page=1&limit=100');
    expect(res100.status).toBe(200);
  });

  it('rejects oversized limit (?limit=1000000) with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?limit=1000000');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('limit must not be greater than 100')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects limit=101 with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?limit=101');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('limit must not be greater than 100')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects non-positive limit (?limit=0) with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?limit=0');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('limit must not be less than 1')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects negative limit (?limit=-10) with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?limit=-10');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('limit must not be less than 1')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects non-positive page (?page=0) with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?page=0');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('page must not be less than 1')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects negative page (?page=-1) with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?page=-1');
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('page must not be less than 1')]),
    );
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });

  it('rejects non-numeric parameters with 400 Bad Request', async () => {
    const res = await request(app.getHttpServer()).get('/courses?limit=notanumber');
    expect(res.status).toBe(400);
    expect(mockCoursesService.findAll).not.toHaveBeenCalled();
  });
});
