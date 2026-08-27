import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RestoreService } from './restore.service';
import { RestoreCoursesDto } from './dto/restore-course.dto';

@ApiTags('backups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('backups/courses')
export class RestoreController {
  constructor(private readonly restoreService: RestoreService) {}

  @Post('restore')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Restore course content from a backup payload (immediate or scheduled)',
  })
  restore(
    @CurrentUser('id') adminId: string,
    @Body() dto: RestoreCoursesDto,
  ) {
    return this.restoreService.requestRestore(adminId, dto);
  }

  @Get('restore/jobs')
  @ApiOperation({ summary: 'List course restore jobs and their status' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listJobs(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.restoreService.listJobs(
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Get('restore/jobs/:id')
  @ApiOperation({ summary: 'Get course restore job status and progress' })
  getStatus(@Param('id') id: string) {
    return this.restoreService.getStatus(id);
  }

  @Post('restore/jobs/:id/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually execute a pending/scheduled restore job' })
  runJob(@Param('id') id: string) {
    return this.restoreService.executeJob(id);
  }
}
