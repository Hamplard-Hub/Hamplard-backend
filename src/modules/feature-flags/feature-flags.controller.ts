import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FeatureFlagsService } from './feature-flags.service';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';
import { EvaluateFeatureFlagDto } from './dto/evaluate-feature-flag.dto';

@ApiTags('feature-flags')
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}

  // ----------------------------------------------------------
  // ADMIN — CRUD
  // ----------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a new feature flag (admin)' })
  create(@Body() dto: CreateFeatureFlagDto) {
    return this.featureFlagsService.create(dto);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all feature flags (admin)' })
  findAll() {
    return this.featureFlagsService.findAll();
  }

  @Get(':key')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get a single feature flag by key (admin)' })
  @ApiParam({ name: 'key', description: 'Feature flag key, e.g. new_payment_flow' })
  findOne(@Param('key') key: string) {
    return this.featureFlagsService.findOne(key);
  }

  @Patch(':key')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a feature flag (admin)' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  update(@Param('key') key: string, @Body() dto: UpdateFeatureFlagDto) {
    return this.featureFlagsService.update(key, dto);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a feature flag (admin)' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  remove(@Param('key') key: string) {
    return this.featureFlagsService.remove(key);
  }

  // ----------------------------------------------------------
  // ADMIN — TOGGLE SHORTCUTS
  // ----------------------------------------------------------

  @Post(':key/enable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Enable a feature flag (admin shortcut)' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  enable(@Param('key') key: string) {
    return this.featureFlagsService.enable(key);
  }

  @Post(':key/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Disable a feature flag (admin shortcut)' })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  disable(@Param('key') key: string) {
    return this.featureFlagsService.disable(key);
  }

  // ----------------------------------------------------------
  // EVALUATION — available to authenticated users
  // ----------------------------------------------------------

  @Get(':key/evaluate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Evaluate a single flag for the calling user (or a specified context)',
  })
  @ApiParam({ name: 'key', description: 'Feature flag key' })
  evaluate(
    @Param('key') key: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query() query: EvaluateFeatureFlagDto,
  ) {
    return this.featureFlagsService.evaluate(key, {
      userId: query.userId ?? userId,
      role: query.role ?? role,
    });
  }

  @Get('evaluate/all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Bulk-evaluate all flags for the calling user — use for SDK bootstrapping',
  })
  evaluateAll(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query() query: EvaluateFeatureFlagDto,
  ) {
    return this.featureFlagsService.evaluateAll({
      userId: query.userId ?? userId,
      role: query.role ?? role,
    });
  }
}
