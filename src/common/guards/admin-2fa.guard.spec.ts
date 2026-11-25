import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { Admin2faGuard, SKIP_ADMIN_2FA_CHECK } from './admin-2fa.guard';

describe('Admin2faGuard', () => {
  let guard: Admin2faGuard;
  let reflector: Reflector;
  let configService: ConfigService;

  const createMockExecutionContext = (user: any, skipCheck = false): ExecutionContext => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;

    // Mock reflector to return skipCheck value
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(skipCheck);

    return mockContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Admin2faGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'REQUIRE_ADMIN_2FA') return 'true';
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<Admin2faGuard>(Admin2faGuard);
    reflector = module.get<Reflector>(Reflector);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('when REQUIRE_ADMIN_2FA is enabled (default)', () => {
    it('should allow non-admin users without 2FA', () => {
      const user = {
        id: 'user-1',
        role: UserRole.STUDENT,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow instructor users without 2FA', () => {
      const user = {
        id: 'user-2',
        role: UserRole.INSTRUCTOR,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow admin users with 2FA enabled', () => {
      const user = {
        id: 'admin-1',
        role: UserRole.ADMIN,
        twoFactorEnabled: true,
      };

      const context = createMockExecutionContext(user);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should block admin users without 2FA', () => {
      const user = {
        id: 'admin-2',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(
        'Two-factor authentication is required for admin accounts',
      );
    });

    it('should allow admin without 2FA when endpoint is marked with @SkipAdmin2faCheck()', () => {
      const user = {
        id: 'admin-3',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user, true);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow requests without user (pre-auth)', () => {
      const context = createMockExecutionContext(null);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow requests with undefined user', () => {
      const context = createMockExecutionContext(undefined);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('when REQUIRE_ADMIN_2FA is disabled', () => {
    beforeEach(() => {
      jest.spyOn(configService, 'get').mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'REQUIRE_ADMIN_2FA') return 'false';
        return defaultValue;
      });

      // Recreate guard with new config
      guard = new Admin2faGuard(reflector, configService);
    });

    it('should allow admin users without 2FA', () => {
      const user = {
        id: 'admin-4',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow all users regardless of 2FA status', () => {
      const users = [
        { id: 'user-1', role: UserRole.STUDENT, twoFactorEnabled: false },
        { id: 'user-2', role: UserRole.INSTRUCTOR, twoFactorEnabled: false },
        { id: 'admin-1', role: UserRole.ADMIN, twoFactorEnabled: false },
        { id: 'admin-2', role: UserRole.ADMIN, twoFactorEnabled: true },
      ];

      users.forEach((user) => {
        const context = createMockExecutionContext(user);
        expect(guard.canActivate(context)).toBe(true);
      });
    });
  });

  describe('error message', () => {
    it('should provide clear instructions for enabling 2FA', () => {
      const user = {
        id: 'admin-5',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);

      try {
        guard.canActivate(context);
        fail('Expected ForbiddenException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.message).toContain('POST /api/v1/auth/2fa/setup');
        expect(error.message).toContain('POST /api/v1/auth/2fa/enable');
      }
    });
  });

  describe('reflector metadata', () => {
    it('should check for SKIP_ADMIN_2FA_CHECK metadata', () => {
      const user = {
        id: 'admin-6',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockExecutionContext(user);
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        SKIP_ADMIN_2FA_CHECK,
        expect.any(Array),
      );
    });
  });
});
