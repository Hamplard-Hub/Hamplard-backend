import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { BadgeRequirementType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { BadgesService, CreateBadgeInput, UpdateBadgeInput } from './badges.service';

class CreateBadgeDto implements CreateBadgeInput {
  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsEnum(BadgeRequirementType)
  requirementType!: BadgeRequirementType;

  @IsInt()
  @Min(1)
  requirementValue!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateBadgeDto implements UpdateBadgeInput {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsEnum(BadgeRequirementType)
  requirementType?: BadgeRequirementType;

  @IsOptional()
  @IsInt()
  @Min(1)
  requirementValue?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class MilestoneEventDto {
  @IsEnum(BadgeRequirementType)
  type!: BadgeRequirementType;
}

@ApiTags('badges')
@Controller('badges')
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'List the configured badge catalog' })
  getCatalog() {
    return this.badgesService.getCatalog();
  }

  @Get('catalog/active')
  @ApiOperation({ summary: 'List active badges available for awarding' })
  getActiveBadges() {
    return this.badgesService.getActiveBadges();
  }

  @Post('catalog')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a badge catalog entry' })
  createBadge(@Body() input: CreateBadgeDto) {
    return this.badgesService.createBadge(input);
  }

  @Post('catalog/seed')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create or update badge catalog entries by code' })
  seedCatalog(@Body() badges: CreateBadgeDto[]) {
    return this.badgesService.seedCatalog(badges);
  }

  @Patch('catalog/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a badge catalog entry' })
  updateBadge(@Param('id') id: string, @Body() input: UpdateBadgeDto) {
    return this.badgesService.updateBadge(id, input);
  }

  @Post('students/:studentId/milestones')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Process an earned student milestone and award badges' })
  handleMilestone(
    @Param('studentId') studentId: string,
    @Body() event: MilestoneEventDto,
  ) {
    return this.badgesService.handleMilestoneEvent(studentId, event);
  }

  @Get('students/:studentId/showcase')
  @ApiOperation({ summary: 'List badges earned by a student' })
  getStudentShowcase(@Param('studentId') studentId: string) {
    return this.badgesService.getStudentShowcase(studentId);
  }
}
