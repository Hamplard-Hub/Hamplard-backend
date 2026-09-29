import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ExecutionContext } from '@nestjs/common';
import * as request from 'supertest';
import { Reflector } from '@nestjs/core';
import { UserRole, PayoutStatus } from '@prisma/client';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, ROLES_KEY } from '../../common/guards/roles.guard';

describe('PayoutsController (Role Authorization)', () => {
  let app: INestApplication;
  let currentUserRole: UserRole = UserRole.STUDENT;

  const mockPayoutsService = {
    getInstructorPayoutHistory: jest.fn(),
    exportPayoutStatement: jest.fn(),
    createPayout: jest.fn(),
    updatePayoutStatus: jest.fn(),
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
      controllers: [PayoutsController],
      providers: [
        { provide: PayoutsService, useValue: mockPayoutsService },
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

  it('has ADMIN role metadata configured on createPayout and updatePayoutStatus handlers', () => {
    const reflector = new Reflector();

    expect(
      reflector.get<UserRole[]>(ROLES_KEY, PayoutsController.prototype.createPayout),
    ).toEqual([UserRole.ADMIN]);
    expect(
      reflector.get<UserRole[]>(ROLES_KEY, PayoutsController.prototype.updatePayoutStatus),
    ).toEqual([UserRole.ADMIN]);
  });

  it('rejects student callers with 403 Forbidden on POST /payouts', async () => {
    currentUserRole = UserRole.STUDENT;

    const response = await request(app.getHttpServer())
      .post('/payouts')
      .send({
        instructorId: 'instructor-1',
        amount: '250.00',
        currency: 'USDC',
      });

    expect(response.status).toBe(403);
    expect(mockPayoutsService.createPayout).not.toHaveBeenCalled();
  });

  it('rejects student callers with 403 Forbidden on PATCH /payouts/:id/status', async () => {
    currentUserRole = UserRole.STUDENT;

    const response = await request(app.getHttpServer())
      .patch('/payouts/pay-1/status')
      .send({
        status: PayoutStatus.COMPLETED,
        txHash: '0xabc123',
      });

    expect(response.status).toBe(403);
    expect(mockPayoutsService.updatePayoutStatus).not.toHaveBeenCalled();
  });

  it('allows admin callers to create a payout and update payout status', async () => {
    currentUserRole = UserRole.ADMIN;

    mockPayoutsService.createPayout.mockResolvedValue({ id: 'pay-1' });
    mockPayoutsService.updatePayoutStatus.mockResolvedValue({ id: 'pay-1', status: PayoutStatus.COMPLETED });

    const createResponse = await request(app.getHttpServer())
      .post('/payouts')
      .send({
        instructorId: 'instructor-1',
        amount: '250.00',
        currency: 'USDC',
      });

    const updateResponse = await request(app.getHttpServer())
      .patch('/payouts/pay-1/status')
      .send({
        status: PayoutStatus.COMPLETED,
        txHash: '0xabc123',
      });

    expect(createResponse.status).toBe(201);
    expect(updateResponse.status).toBe(200);
    expect(mockPayoutsService.createPayout).toHaveBeenCalled();
    expect(mockPayoutsService.updatePayoutStatus).toHaveBeenCalledWith('pay-1', {
      status: PayoutStatus.COMPLETED,
      txHash: '0xabc123',
    });
  });
});
