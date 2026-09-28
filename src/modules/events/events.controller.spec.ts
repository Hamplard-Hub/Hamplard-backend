import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { UserRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, ROLES_KEY } from '../../common/guards/roles.guard';

describe('EventsController (Role Authorization)', () => {
  let app: INestApplication;
  let currentUserRole: UserRole = UserRole.STUDENT;

  const mockEventsService = {
    findAll: jest.fn().mockResolvedValue({
      events: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    }),
  };

  const mockJwtGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'user-1', role: currentUserRole };
      return true;
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: mockEventsService },
        Reflector,
        RolesGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('has ADMIN role metadata configured on findAll handler', () => {
    const reflector = new Reflector();
    const roles = reflector.get<UserRole[]>(ROLES_KEY, EventsController.prototype.findAll);
    expect(roles).toEqual([UserRole.ADMIN]);
  });

  it('rejects student callers with 403 Forbidden', async () => {
    currentUserRole = UserRole.STUDENT;

    const response = await request(app.getHttpServer()).get('/events');

    expect(response.status).toBe(403);
    expect(mockEventsService.findAll).not.toHaveBeenCalled();
  });

  it('rejects instructor callers with 403 Forbidden', async () => {
    currentUserRole = UserRole.INSTRUCTOR;

    const response = await request(app.getHttpServer()).get('/events');

    expect(response.status).toBe(403);
    expect(mockEventsService.findAll).not.toHaveBeenCalled();
  });

  it('allows admin callers with 200 OK', async () => {
    currentUserRole = UserRole.ADMIN;

    const response = await request(app.getHttpServer()).get('/events');

    expect(response.status).toBe(200);
    expect(mockEventsService.findAll).toHaveBeenCalled();
  });
});
