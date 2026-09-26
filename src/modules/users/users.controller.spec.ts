import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, BadRequestException, ConflictException, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';

describe('UsersController (UpdateProfile Validation)', () => {
  let app: INestApplication;
  let service: UsersService;

  const mockUsersService = {
    findById: jest.fn(),
    updateProfile: jest.fn(),
  };

  const mockJwtGuard = {
    canActivate: jest.fn((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { id: 'user-1', role: 'STUDENT' };
      return true;
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: mockUsersService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    service = moduleRef.get<UsersService>(UsersService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects update request with invalid email format with 400 Bad Request', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(mockUsersService.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects update request with oversized name (>100 chars) with 400 Bad Request', async () => {
    const longName = 'a'.repeat(101);
    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ name: longName });

    expect(response.status).toBe(400);
    expect(mockUsersService.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects update request with invalid avatarUrl with 400 Bad Request', async () => {
    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ avatarUrl: 'invalid-url' });

    expect(response.status).toBe(400);
    expect(mockUsersService.updateProfile).not.toHaveBeenCalled();
  });

  it('returns 409 Conflict when updating to an email that is already taken (Prisma P2002)', async () => {
    mockUsersService.updateProfile.mockRejectedValue(
      new ConflictException('An account with this email address already exists'),
    );

    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ email: 'taken@example.com' });

    expect(response.status).toBe(409);
    expect(mockUsersService.updateProfile).toHaveBeenCalledWith('user-1', {
      email: 'taken@example.com',
    });
  });

  it('successfully updates profile with valid partial data', async () => {
    const updatedUser = { id: 'user-1', name: 'Valid Name', email: 'valid@example.com' };
    mockUsersService.updateProfile.mockResolvedValue(updatedUser);

    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ name: 'Valid Name', email: 'valid@example.com' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(updatedUser);
    expect(mockUsersService.updateProfile).toHaveBeenCalledWith('user-1', {
      name: 'Valid Name',
      email: 'valid@example.com',
    });
  });
});
