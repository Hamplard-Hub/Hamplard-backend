import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CaptchaService } from './captcha.service';
import { RefreshTokenService } from './refresh-token.service';
import { SessionsService } from './sessions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('Auth logout (e2e)', () => {
  let app: INestApplication;
  let refreshTokens: RefreshTokenService;
  const sessions = new Map<string, any>();
  const refreshTokenRecords = new Map<string, any>();

  const prisma = {
    session: {
      create: jest.fn(async ({ data }) => {
        const session = { id: `session-${data.jti}`, ...data, revokedAt: null };
        sessions.set(data.jti, session);
        return session;
      }),
      findUnique: jest.fn(async ({ where }) => sessions.get(where.jti) ?? null),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const [jti, session] of sessions) {
          if (
            (!where.userId || session.userId === where.userId) &&
            (!where.jti || session.jti === where.jti) &&
            (!where.refreshFamilyId || session.refreshFamilyId === where.refreshFamilyId) &&
            (!where.revokedAt || session.revokedAt === where.revokedAt)
          ) {
            sessions.set(jti, { ...session, ...data });
            count += 1;
          }
        }
        return { count };
      }),
    },
    refreshToken: {
      create: jest.fn(async ({ data }) => {
        refreshTokenRecords.set(data.tokenHash, { ...data });
        return data;
      }),
      findUnique: jest.fn(async ({ where }) => refreshTokenRecords.get(where.tokenHash) ?? null),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const [tokenHash, token] of refreshTokenRecords) {
          if (
            (!where.familyId || token.familyId === where.familyId) &&
            (!where.userId || token.userId === where.userId) &&
            (!where.id || token.id === where.id) &&
            (!where.revokedAt || token.revokedAt === where.revokedAt) &&
            (!where.consumedAt || token.consumedAt === where.consumedAt)
          ) {
            refreshTokenRecords.set(tokenHash, { ...token, ...data });
            count += 1;
          }
        }
        return { count };
      }),
    },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        stellarAddress: null,
        role: 'STUDENT',
        deletedAt: null,
      }),
    },
  };

  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      const values = {
        JWT_SECRET: 'test-access-secret',
        JWT_REFRESH_SECRET: 'test-refresh-secret',
        JWT_REFRESH_EXPIRES_IN: '30d',
      };
      return values[key] ?? fallback;
    }),
  };

  beforeAll(async () => {
    const jwt = new JwtService({ secret: 'test-access-secret' });
    const sessionsService = new SessionsService(prisma as unknown as PrismaService);
    refreshTokens = new RefreshTokenService(
      prisma as unknown as PrismaService,
      jwt,
      config as any,
    );
    const authService = {
      refresh: (token: string) => refreshTokens.rotate(token),
      logout: (userId: string, jti?: string) =>
        sessionsService.logoutCurrentSession(userId, jti),
      logoutAll: (userId: string) => sessionsService.logoutAll(userId),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: CaptchaService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().user = {
            id: 'user-1',
            jti: 'current-access-jti',
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    sessions.clear();
    refreshTokenRecords.clear();
    jest.clearAllMocks();
  });

  it('rejects refresh after the current session logs out', async () => {
    const tokens = await refreshTokens.issueTokenPair({
      id: 'user-1',
      stellarAddress: null,
      role: 'STUDENT',
    });
    const accessPayload = new JwtService({ secret: 'test-access-secret' }).decode(
      tokens.accessToken,
    ) as { jti: string; familyId: string; exp: number };
    await prisma.session.create({
      data: {
        userId: 'user-1',
        jti: 'current-access-jti',
        refreshFamilyId: accessPayload.familyId,
        expiresAt: new Date(accessPayload.exp * 1000),
      },
    });

    const logoutResponse = await request(app.getHttpServer()).post('/auth/logout').expect(200);
    expect(logoutResponse.body.revoked).toBe(true);
    expect(sessions.get('current-access-jti').revokedAt).toBeInstanceOf(Date);
    expect([...refreshTokenRecords.values()][0].revokedAt).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
  });
});
