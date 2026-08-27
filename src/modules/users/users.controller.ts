import { Controller, Get, Patch, Post, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { BanUserDto } from './dto/ban-user.dto';
import { UnbanUserDto } from './dto/unban-user.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { UnsuspendUserDto } from './dto/unsuspend-user.dto';
import { Request } from 'express';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  getMe(@CurrentUser('id') userId: string) {
    return this.usersService.findById(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile (name, email, bio, avatar)' })
  updateMe(
    @CurrentUser('id') userId: string,
    @Body() body: { name?: string; email?: string; bio?: string; avatarUrl?: string },
  ) {
    return this.usersService.updateProfile(userId, body);
  }

  @Get(':address/public')
  @ApiOperation({ summary: 'Get public instructor profile by Stellar address' })
  getPublicProfile(@Param('address') address: string) {
    return this.usersService.findByAddress(address);
  }

  @Get('me/instructor-stats')
  @ApiOperation({ summary: 'Get instructor revenue and enrollment stats' })
  getInstructorStats(@CurrentUser('stellarAddress') address: string) {
    return this.usersService.getInstructorStats(address);
  }

  // ============================================================
  // ADMIN ENDPOINTS - User Management
  // ============================================================

  @Post(':userId/ban')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Ban a user permanently' })
  @ApiBearerAuth()
  async banUser(
    @Param('userId') userId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: BanUserDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.usersService.banUser(userId, adminId, dto.reason, ipAddress);
  }

  @Post(':userId/unban')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Unban a user' })
  @ApiBearerAuth()
  async unbanUser(
    @Param('userId') userId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: UnbanUserDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.usersService.unbanUser(userId, adminId, dto.reason, ipAddress);
  }

  @Post(':userId/suspend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Suspend a user temporarily' })
  @ApiBearerAuth()
  async suspendUser(
    @Param('userId') userId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    const suspendedUntil = new Date(dto.suspendedUntil);
    return this.usersService.suspendUser(userId, adminId, dto.reason, suspendedUntil, ipAddress);
  }

  @Post(':userId/unsuspend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Lift suspension from a user' })
  @ApiBearerAuth()
  async unsuspendUser(
    @Param('userId') userId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: UnsuspendUserDto,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.socket.remoteAddress;
    return this.usersService.unsuspendUser(userId, adminId, dto.reason, ipAddress);
  }

  @Get(':userId/account-status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '[Admin] Check user account status (ban/suspend)' })
  @ApiBearerAuth()
  async checkAccountStatus(@Param('userId') userId: string) {
    return this.usersService.checkAccountStatus(userId);
  }
}
