import { Injectable, ExecutionContext, UnauthorizedException, ForbiddenException, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ALLOW_DEACTIVATED_KEY } from '../decorators/allow-deactivated.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(
        @Optional() private readonly reflector?: Reflector,
    ) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // JwtStrategy.validate runs the JWT check, account-status checks, and
        // session revocation/expiry enforcement (issues #69/#418) — the latter
        // is shared with OptionalJwtAuthGuard by living in the strategy.
        const canActivate = await super.canActivate(context);
        if (!canActivate) {
            return false;
        }

        // Get the request object
        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || !user.id) {
            throw new UnauthorizedException('Invalid token payload');
        }

        // Issues #74/#75 — deactivated accounts may only reach routes that opt in
        // (the reactivation endpoint). This needs the Reflector so it stays in the
        // guard rather than the strategy.
        if (user.isDeactivated) {
            const allowed = this.reflector?.getAllAndOverride<boolean>(ALLOW_DEACTIVATED_KEY, [
                context.getHandler(),
                context.getClass(),
            ]);
            if (!allowed) {
                throw new ForbiddenException('Account is deactivated');
            }
        }

        return true;
    }
}
