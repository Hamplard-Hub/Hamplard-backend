import {
  Controller, Get, Post, Patch, Body,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReferralsService } from './referrals.service';
import { ValidateReferralDto } from './dto/validate-referral.dto';
import { ApplyReferralRewardDto } from './dto/apply-referral-reward.dto';
import { UpdateRewardRulesDto } from './dto/update-reward-rules.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('referrals')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  // ----------------------------------------------------------
  // PUBLIC — VALIDATE CODE (registration / share links)
  // ----------------------------------------------------------

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a referral code (used at registration)' })
  validate(@Body() dto: ValidateReferralDto) {
    return this.referralsService.validateCode(dto.code);
  }

  // ----------------------------------------------------------
  // AUTHENTICATED STUDENT — CODE, STATUS, REWARDS
  // ----------------------------------------------------------

  @Post('code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate (or return existing) personal referral code' })
  generateCode(@CurrentUser('id') userId: string) {
    return this.referralsService.getOrCreateCode(userId);
  }

  @Get('code')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my referral code (creates one if missing)' })
  getCode(@CurrentUser('id') userId: string) {
    return this.referralsService.getOrCreateCode(userId);
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get referral performance status (signups, conversions, rewards)' })
  getStatus(@CurrentUser('id') userId: string) {
    return this.referralsService.getPerformanceStatus(userId);
  }

  @Get('rewards')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my referral enrollment discount rewards' })
  listRewards(@CurrentUser('id') userId: string) {
    return this.referralsService.listMyRewards(userId);
  }

  @Post('rewards/preview')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview a referral reward discount for a course price' })
  previewReward(
    @CurrentUser('id') userId: string,
    @Body() dto: ApplyReferralRewardDto,
  ) {
    return this.referralsService.previewReward(userId, dto.originalPrice, dto.rewardId);
  }

  @Post('rewards/redeem')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem a referral reward after a successful enrollment' })
  redeemReward(
    @CurrentUser('id') userId: string,
    @Body() body: { rewardId: string; enrollmentId: string },
  ) {
    return this.referralsService.redeemReward(userId, body.rewardId, body.enrollmentId);
  }

  @Patch('code/deactivate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deactivate my referral code' })
  deactivate(@CurrentUser('id') userId: string) {
    return this.referralsService.deactivateCode(userId);
  }

  // ----------------------------------------------------------
  // ADMIN — REWARD RULES
  // ----------------------------------------------------------

  @Get('rules')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'View referral reward issuance rules (admin)' })
  getRules() {
    return this.referralsService.getRewardRules();
  }

  @Patch('rules')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update referral reward issuance rules (admin)' })
  updateRules(@Body() dto: UpdateRewardRulesDto) {
    return this.referralsService.updateRewardRules(dto);
  }
}
