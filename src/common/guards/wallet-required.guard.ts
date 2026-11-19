import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletRequiredGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;

    if (!userId) return true;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stellarAddress: true, googleId: true },
    });

    if (!user?.stellarAddress) {
      throw new ForbiddenException(
        'A linked Stellar wallet is required for this action. Please link your wallet in account settings.',
      );
    }

    return true;
  }
}