import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CourseAutosaveService } from './course-autosave.service';
import { AutosaveCourseDto } from './dto/autosave-course.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('course-autosave')
@Controller('courses/autosave')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
@ApiBearerAuth()
export class CourseAutosaveController {
  constructor(private readonly autosaveService: CourseAutosaveService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Periodically autosave in-progress course edits before submission' })
  autosave(
    @CurrentUser('id') userId: string,
    @CurrentUser('stellarAddress') address: string,
    @Body() dto: AutosaveCourseDto,
  ) {
    return this.autosaveService.autosave(userId, address, dto);
  }

  @Get('recovered')
  @ApiOperation({ summary: 'Provide recovered course draft on next login or session restore' })
  @ApiQuery({ name: 'courseId', required: false, description: 'Optional course ID to fetch draft for' })
  getRecoveredDraft(
    @CurrentUser('id') userId: string,
    @Query('courseId') courseId?: string,
  ) {
    return this.autosaveService.getRecoveredDraft(userId, courseId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific autosaved draft by ID' })
  getDraftById(
    @Param('id') draftId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.autosaveService.getDraftById(draftId, userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discard an in-progress draft' })
  discardDraft(
    @Param('id') draftId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.autosaveService.discardDraft(draftId, userId);
  }
}
