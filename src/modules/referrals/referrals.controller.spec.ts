import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

describe('ReferralsController', () => {
  let app: INestApplication;
  const referralsService = {
    redeemReward: jest.fn(),
    validateCode: jest.fn(),
    getOrCreateCode: jest.fn(),
    getPerformanceStatus: jest.fn(),
    listMyRewards: jest.fn(),
    previewReward: jest.fn(),
    deactivateCode: jest.fn(),
    getRewardRules: jest.fn(),
    updateRewardRules: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ReferralsController],
      providers: [{ provide: ReferralsService, useValue: referralsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: 'auth-user', role: 'STUDENT' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    referralsService.redeemReward.mockResolvedValue({
      id: 'rw-1',
      status: 'REDEEMED',
    });
  });

  it('rejects redemption payloads that omit enrollmentId', async () => {
    const response = await request(app.getHttpServer())
      .post('/referrals/rewards/redeem')
      .send({ rewardId: '00000000-0000-4000-8000-000000000001' });

    expect(response.status).toBe(400);
    expect(referralsService.redeemReward).not.toHaveBeenCalled();
  });

  it('passes validated identifiers to the service', async () => {
    const rewardId = '00000000-0000-4000-8000-000000000001';
    const enrollmentId = '00000000-0000-4000-8000-000000000002';

    const response = await request(app.getHttpServer())
      .post('/referrals/rewards/redeem')
      .send({ rewardId, enrollmentId });

    expect(response.status).toBe(200);
    expect(referralsService.redeemReward).toHaveBeenCalledWith(
      'auth-user',
      rewardId,
      enrollmentId,
    );
  });
});
