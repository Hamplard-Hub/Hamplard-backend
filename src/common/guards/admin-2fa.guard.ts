import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

/**
 * Metadata key to allow endpoints to skip 2FA enforcement.
 * Used for the 2FA setup flow itself.
 */
export const SKIP_ADMIN_2FA_CHECK = 'skipAdmin2faCheck';

/**
 * Decorator to mark endpoints that should allow admins without 2FA.
 * Use sparingly — only for the 2FA setup endpoints and essential read-only operations.
 */
export function SkipAdmin2faCheck() {
  return (target: any, key?: string, descriptor?: any) => {
    Reflect.defineMetadata(SKIP_ADMIN_2FA_CHECK, true, descriptor?.value ?? target);
    return descriptor ?? target;
  };
}

/**
 * Guard that enforces two-factor authentication for admin accounts.
 * 
 * When REQUIRE_ADMIN_2FA=true (default):
 * - Admin users must have 2FA enabled to access protected endpoints
 * - Non-admin users are not affected
 * - Endpoints marked with @SkipAdmin2faCheck() are exempt (for setup flow)
 * 
 * This prevents admins from performing sensitive operations (impersonation,
 * refunds, payouts) without 2FA protection.
 */
@Injectable()
export class Admin2faGuard implements CanActivate {
  private readonly logger = new Logger(Admin2faGuard.name);
  private readonly requireAdmin2fa: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    this.requireAdmin2fa = this.config.get<string>('REQUIRE_ADMIN_2FA', 'true') === 'true';
    
    if (this.requireAdmin2fa) {
      this.logger.log('Admin 2FA enforcement is ENABLED');
    } else {
      this.logger.warn('Admin 2FA enforcement is DISABLED — set REQUIRE_ADMIN_2FA=true in production');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // If 2FA requirement is disabled globally, allow all requests
    if (!this.requireAdmin2fa) {
      return true;
    }

    // Check if endpoint is marked to skip 2FA check
    const skipCheck = this.reflector.getAllAndOverride<boolean>(SKIP_ADMIN_2FA_CHECK, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipCheck) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // No user attached means JwtAuthGuard should have rejected it
    if (!user) {
      return true;
    }

    // Only enforce for admin users
    if (user.role !== UserRole.ADMIN) {
      return true;
    }

    // Admin must have 2FA enabled
    if (!user.twoFactorEnabled) {
      this.logger.warn(
        `Admin user ${user.id} attempted to access protected endpoint without 2FA enabled`,
      );

      throw new ForbiddenException(
        'Two-factor authentication is required for admin accounts. ' +
        'Please enable 2FA at POST /api/v1/auth/2fa/setup and POST /api/v1/auth/2fa/enable before accessing admin endpoints.',
      );
    }

    return true;
  }
}
