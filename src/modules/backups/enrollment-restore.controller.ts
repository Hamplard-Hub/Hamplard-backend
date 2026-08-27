import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EnrollmentRestoreService } from './enrollment-restore.service';
import { RestoreEnrollmentsDto } from './dto/restore-enrollments.dto';

@ApiTags('backups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('backups/enrollments')
export class EnrollmentRestoreController {
  constructor(
    private readonly enrollmentRestoreService: EnrollmentRestoreService,
  ) {}

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore student enrollments and progress from a backup payload',
  })
  restore(
    @CurrentUser('id') adminId: string,
    @Body() dto: RestoreEnrollmentsDto,
  ) {
    return this.enrollmentRestoreService.restore(adminId, dto);
  }

  @Get('restore/reports')
  @ApiOperation({ summary: 'List enrollment restore summary reports' })
  listReports() {
    return this.enrollmentRestoreService.listReports();
  }

  @Get('restore/reports/:id')
  @ApiOperation({ summary: 'Get an enrollment restore summary report by id' })
  getReport(@Param('id') id: string) {
    const report = this.enrollmentRestoreService.getReport(id);
    if (!report) {
      throw new NotFoundException(`Restore report ${id} not found`);
    }
    return report;
  }
}
