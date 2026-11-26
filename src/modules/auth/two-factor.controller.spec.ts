import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { TwoFactorController } from './two-factor.controller';
import { TwoFactorService } from './two-factor.service';
import { Admin2faGuard, SKIP_ADMIN_2FA_CHECK } from '../../common/guards/admin-2fa.guard';
import { UserRole } from '@prisma/client';

describe('TwoFactorController — Admin 2FA Guard Integration', () => {
  let controller: TwoFactorController;
  let guard: Admin2faGuard;
  let reflector: Reflector;

  const mockTwoFactorService = {
    generateSecret: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
    getStatus: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'REQUIRE_ADMIN_2FA') return 'true';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TwoFactorController],
      providers: [
        {
          provide: TwoFactorService,
          useValue: mockTwoFactorService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        Reflector,
        Admin2faGuard,
      ],
    }).compile();

    controller = module.get<TwoFactorController>(TwoFactorController);
    guard = module.get<Admin2faGuard>(Admin2faGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Guard Application', () => {
    it('should have Admin2faGuard applied to the controller', () => {
      const guards = Reflect.getMetadata('__guards__', TwoFactorController);
      expect(guards).toBeDefined();
    });
  });

  describe('@SkipAdmin2faCheck() decorator', () => {
    it('should mark setup endpoint to skip 2FA check', () => {
      const metadata = Reflect.getMetadata(SKIP_ADMIN_2FA_CHECK, controller.setup);
      expect(metadata).toBe(true);
    });

    it('should mark enable endpoint to skip 2FA check', () => {
      const metadata = Reflect.getMetadata(SKIP_ADMIN_2FA_CHECK, controller.enable);
      expect(metadata).toBe(true);
    });

    it('should mark status endpoint to skip 2FA check', () => {
      const metadata = Reflect.getMetadata(SKIP_ADMIN_2FA_CHECK, controller.status);
      expect(metadata).toBe(true);
    });

    it('should NOT mark disable endpoint to skip 2FA check', () => {
      const metadata = Reflect.getMetadata(SKIP_ADMIN_2FA_CHECK, controller.disable);
      expect(metadata).not.toBe(true);
    });

    it('should NOT mark regenerateRecoveryCodes endpoint to skip 2FA check', () => {
      const metadata = Reflect.getMetadata(SKIP_ADMIN_2FA_CHECK, controller.regenerateRecoveryCodes);
      expect(metadata).not.toBe(true);
    });
  });

  describe('Admin 2FA Enforcement Flow', () => {
    const createMockContext = (user: any, method: Function) => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
        getHandler: () => method,
        getClass: () => TwoFactorController,
      } as any;

      return mockContext;
    };

    it('should allow admin without 2FA to call setup endpoint', () => {
      const adminWithout2fa = {
        id: 'admin-1',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockContext(adminWithout2fa, controller.setup);

      // The reflector should return true for SKIP_ADMIN_2FA_CHECK
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow admin without 2FA to call enable endpoint', () => {
      const adminWithout2fa = {
        id: 'admin-2',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockContext(adminWithout2fa, controller.enable);
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow admin without 2FA to call status endpoint', () => {
      const adminWithout2fa = {
        id: 'admin-3',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockContext(adminWithout2fa, controller.status);
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should block admin without 2FA from calling disable endpoint', () => {
      const adminWithout2fa = {
        id: 'admin-4',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      const context = createMockContext(adminWithout2fa, controller.disable);
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow admin with 2FA to call any endpoint', () => {
      const adminWith2fa = {
        id: 'admin-5',
        role: UserRole.ADMIN,
        twoFactorEnabled: true,
      };

      const endpoints = [
        controller.setup,
        controller.enable,
        controller.disable,
        controller.status,
      ];

      endpoints.forEach((endpoint) => {
        const context = createMockContext(adminWith2fa, endpoint);
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
        expect(guard.canActivate(context)).toBe(true);
      });
    });

    it('should allow instructor without 2FA to call any endpoint', () => {
      const instructorWithout2fa = {
        id: 'instructor-1',
        role: UserRole.INSTRUCTOR,
        twoFactorEnabled: false,
      };

      const endpoints = [
        controller.setup,
        controller.enable,
        controller.disable,
        controller.status,
      ];

      endpoints.forEach((endpoint) => {
        const context = createMockContext(instructorWithout2fa, endpoint);
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
        expect(guard.canActivate(context)).toBe(true);
      });
    });
  });

  describe('Grace Setup Flow', () => {
    it('should allow admin to complete 2FA setup flow from scratch', () => {
      const adminWithout2fa = {
        id: 'admin-new',
        role: UserRole.ADMIN,
        twoFactorEnabled: false,
      };

      // Step 1: Check status (allowed)
      const statusContext = {
        switchToHttp: () => ({ getRequest: () => ({ user: adminWithout2fa }) }),
        getHandler: () => controller.status,
        getClass: () => TwoFactorController,
      } as any;
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      expect(guard.canActivate(statusContext)).toBe(true);

      // Step 2: Generate secret (allowed)
      const setupContext = {
        switchToHttp: () => ({ getRequest: () => ({ user: adminWithout2fa }) }),
        getHandler: () => controller.setup,
        getClass: () => TwoFactorController,
      } as any;
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      expect(guard.canActivate(setupContext)).toBe(true);

      // Step 3: Enable 2FA (allowed)
      const enableContext = {
        switchToHttp: () => ({ getRequest: () => ({ user: adminWithout2fa }) }),
        getHandler: () => controller.enable,
        getClass: () => TwoFactorController,
      } as any;
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      expect(guard.canActivate(enableContext)).toBe(true);

      // After enabling, admin can access disable endpoint
      const adminWith2fa = { ...adminWithout2fa, twoFactorEnabled: true };
      const disableContext = {
        switchToHttp: () => ({ getRequest: () => ({ user: adminWith2fa }) }),
        getHandler: () => controller.disable,
        getClass: () => TwoFactorController,
      } as any;
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      expect(guard.canActivate(disableContext)).toBe(true);
    });
  });
});
