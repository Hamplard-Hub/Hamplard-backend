// sessions.controller.ts — issue #69: session and device management
import { Controller, Get, Delete, Post, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SessionsService } from './sessions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Get()
  @ApiOperation({ summary: 'List active login sessions across devices for the current user' })
  list(@CurrentUser('id') userId: string, @CurrentUser('jti') jti: string) {
    return this.sessionsService.listSessions(userId, jti);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a single session (must be owned by the current user)' })
  revoke(@CurrentUser('id') userId: string, @Param('id') sessionId: string) {
    return this.sessionsService.revokeSession(userId, sessionId);
  }

  @Post('revoke-all')
  @ApiOperation({ summary: 'Revoke every session for the current user except the one in use' })
  revokeAll(@CurrentUser('id') userId: string, @CurrentUser('jti') jti: string) {
    return this.sessionsService.revokeAllExceptCurrent(userId, jti);
  }
}
