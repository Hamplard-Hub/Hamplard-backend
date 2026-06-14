import { Controller, Get, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
}
