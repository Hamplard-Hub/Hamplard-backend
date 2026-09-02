import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  hashRefreshToken,
  parseDurationMs,
  RefreshTokenService,
} from './refresh-token.service';

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 1000);

const user = {
  id: 'user-1',
  stellarAddress: 'GABC',
  googleId: null,
  role: 'STUDENT',
};

describe('parseDurationMs', () => {
  it('parses second, minute, hour, and day suffixes', () => {
    expect(parseDurationMs('15s', 0)).toBe(15_000);
    expect(parseDurationMs('15m', 0)).toBe(15 * 60 * 1000);
    expect(parseDurationMs('2h', 0)).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationMs('30d', 0)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('falls back when the value is not a duration', () => {
    expect(parseDurationMs('nope', 42)).toBe(42);
  });
});

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const mockPrisma: any = {
    user: { findUnique: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockJwt = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const values: Record<string, string> = {
        JWT_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
        JWT_REFRESH_EXPIRES_IN: '30d',
      };
      return values[key] ?? defaultValue;
    }),
  };

  const activeRecord = (generation = 1, token = `refresh-${generation}`) => ({
    id: `jti-${generation}`,
    userId: user.id,
    familyId: 'family-1',
    generation,
    tokenHash: hashRefreshToken(token),
    expiresAt: future,
    consumedAt: null,
    revokedAt: null,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(RefreshTokenService);
    jest.clearAllMocks();

    mockJwt.sign.mockImplementation((payload: any) => {
      if (payload.typ === 'refresh') return `refresh-${payload.generation}`;
      return `access-${payload.sub}`;
    });
    mockJwt.verify.mockImplementation((token: string) => {
      const match = /^refresh-(\d+)$/.exec(token);
      if (!match) {
        const error = new Error('invalid token');
        error.name = 'JsonWebTokenError';
        throw error;
      }
      const generation = Number(match[1]);
      return {
        sub: user.id,
        familyId: 'family-1',
        generation,
        typ: 'refresh',
        jti: `jti-${generation}`,
      };
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(user);
  });

  describe('issueTokenPair()', () => {
    it('issues an access/refresh pair in a new family at generation 1', async () => {
      const result = await service.issueTokenPair(user);

      expect(result.accessToken).toBe('access-user-1');
      expect(result.refreshToken).toBe('refresh-1');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: user.id,
          stellarAddress: user.stellarAddress,
          role: user.role,
        }),
      );
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: user.id,
          generation: 1,
          typ: 'refresh',
        }),
        { secret: 'refresh-secret', expiresIn: '30d' },
      );
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: user.id,
          generation: 1,
          tokenHash: hashRefreshToken('refresh-1'),
        }),
      });
      const created = mockPrisma.refreshToken.create.mock.calls[0][0].data;
      expect(created.familyId).toEqual(expect.any(String));
      expect(created.tokenHash).not.toBe('refresh-1');
    });

    it('tracks family id and the next generation when rotating within a family', async () => {
      await service.issueTokenPair(user, 'family-1', 4);

      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          familyId: 'family-1',
          generation: 4,
          tokenHash: hashRefreshToken('refresh-4'),
        }),
      });
    });
  });

  describe('rotate()', () => {
    it('exchanges a valid refresh token for a new access/refresh pair', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(activeRecord(1));

      const result = await service.rotate('refresh-1');

      expect(result.accessToken).toBe('access-user-1');
      expect(result.refreshToken).toBe('refresh-2');
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          familyId: 'family-1',
          generation: 2,
          tokenHash: hashRefreshToken('refresh-2'),
        }),
      });
    });

    it('invalidates the previous refresh token on a successful rotation', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(activeRecord(1));

      await service.rotate('refresh-1');

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'jti-1', consumedAt: null, revokedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    it('detects reuse of an already-consumed refresh token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...activeRecord(1),
        consumedAt: new Date(),
      });

      await expect(service.rotate('refresh-1')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token reuse detected');
    });

    it('revokes the entire token family when reuse is detected', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...activeRecord(1),
        consumedAt: new Date(),
      });

      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token reuse detected');

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('prevents replay of a previously rotated token', async () => {
      mockPrisma.refreshToken.findUnique
        .mockResolvedValueOnce(activeRecord(1))
        .mockResolvedValueOnce({ ...activeRecord(1), consumedAt: new Date() });

      const first = await service.rotate('refresh-1');
      expect(first.refreshToken).toBe('refresh-2');

      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token reuse detected');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('treats a concurrent consume as reuse and revokes the family', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(activeRecord(1));
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token reuse detected');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('rejects an expired refresh token without issuing a new pair', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...activeRecord(1),
        expiresAt: past,
      });

      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token expired');
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a revoked family token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...activeRecord(1),
        revokedAt: new Date(),
      });

      await expect(service.rotate('refresh-1')).rejects.toThrow(
        'Refresh token has been revoked',
      );
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an access token presented as a refresh token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
      mockJwt.verify.mockReturnValue({
        sub: user.id,
        stellarAddress: user.stellarAddress,
        role: user.role,
      });

      await expect(service.rotate('access-user-1')).rejects.toThrow('Invalid refresh token');
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a malformed refresh token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.rotate('not-a-jwt')).rejects.toThrow('Invalid refresh token');
    });

    it('revokes the family when a verifying token is no longer stored', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.rotate('refresh-1')).rejects.toThrow('Refresh token reuse detected');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
