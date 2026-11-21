import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app.module';
import { CaptchaService } from '../src/modules/auth/captcha.service';
import { EventsService } from '../src/modules/events/events.service';
import { VirusScanService } from '../src/modules/uploads/virus-scan.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

describe('App E2E Test Suite', () => {
  let app: INestApplication;
  let keypair: Keypair;
  let nonce: string;

  const mockUsers: any[] = [];
  const mockCourses: any[] = [
    {
      id: 'c-1',
      title: 'Demo Course',
      category: 'Tailoring',
      status: 'ACTIVE',
      price: 20,
      instructorAddress: 'GDINSTRUCTOR',
      modules: [],
    },
  ];

  const mockPrismaService = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    user: {
      findUnique: jest.fn().mockImplementation(({ where }) => {
        if (where.stellarAddress) {
          return mockUsers.find((u) => u.stellarAddress === where.stellarAddress) || null;
        }
        if (where.id) {
          return mockUsers.find((u) => u.id === where.id) || null;
        }
        return null;
      }),
      create: jest.fn().mockImplementation(({ data }) => {
        const user = { id: `user-${mockUsers.length + 1}`, ...data };
        mockUsers.push(user);
        return user;
      }),
      upsert: jest.fn().mockImplementation(({ create, update, where }) => {
        let user = mockUsers.find((u) => u.stellarAddress === where.stellarAddress);
        if (!user) {
          user = { id: `user-${mockUsers.length + 1}`, ...create };
          mockUsers.push(user);
        } else {
          Object.assign(user, update);
        }
        return user;
      }),
      update: jest.fn(),
    },
    course: {
      findMany: jest.fn().mockResolvedValue(mockCourses),
      findUnique: jest.fn().mockResolvedValue(mockCourses[0]),
      count: jest.fn().mockResolvedValue(1),
    },
    refreshToken: {
      create: jest.fn().mockResolvedValue({ id: 'rt-1', token: 'mock-refresh' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    session: {
      create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    eventPollerCheckpoint: {
      findUnique: jest.fn().mockResolvedValue({ lastProcessedLedger: 100 }),
    },
    cronJobRun: {
      create: jest.fn().mockResolvedValue({ id: 'cron-1', startedAt: new Date() }),
      update: jest.fn().mockResolvedValue({ id: 'cron-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  beforeAll(async () => {
    keypair = Keypair.random();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(CaptchaService)
      .useValue({
        verifyBeforeNonce: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(EventsService)
      .useValue({
        getCheckpointStatus: jest.fn().mockResolvedValue({
          healthy: true,
          lastProcessedLedger: 1000,
          persistedLedger: 1000,
          resumedFromCheckpoint: false,
          consecutiveWriteFailures: 0,
        }),
      })
      .overrideProvider(VirusScanService)
      .useValue({
        getScannerStatus: jest.fn().mockReturnValue({
          enabled: false,
          available: false,
        }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
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
    await app.close();
  });

  describe('Health Endpoint', () => {
    it('GET /api/v1/health returns health status', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health');
      expect([200, 503]).toContain(res.status);
    });
  });

  describe('Auth Flow (Nonce & Login with Stellar Keypair)', () => {
    it('GET /api/v1/auth/nonce requests challenge nonce for Stellar address', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/auth/nonce?address=${keypair.publicKey()}&captchaToken=dummy-captcha`)
        .expect(200);

      expect(res.body).toHaveProperty('nonce');
      expect(res.body.address).toBe(keypair.publicKey());
      nonce = res.body.nonce;
    });

    it('POST /api/v1/auth/login authenticates student with Ed25519 signature', async () => {
      const signature = keypair.sign(Buffer.from(nonce)).toString('base64');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          stellarAddress: keypair.publicKey(),
          signedNonce: nonce,
          signature,
          role: 'STUDENT',
        })
        .expect(200);

      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body).toHaveProperty('user');
    });
  });

  describe('Course List', () => {
    it('GET /api/v1/courses returns list of available courses', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/courses')
        .expect(200);

      expect(Array.isArray(res.body) || Array.isArray(res.body.courses)).toBe(true);
    });
  });
});
