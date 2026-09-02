import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { UserRole, LearningPathStatus } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LearningPathsService } from './learning-paths.service';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { SetPathCoursesDto } from './dto/set-courses.dto';
import { QueryPathsDto } from './dto/query-paths.dto';

@ApiTags('learning-paths')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('learning-paths')
export class LearningPathsController {
  constructor(private readonly pathsService: LearningPathsService) {}

  // ----------------------------------------------------------
  // CREATE — admin only
  // ----------------------------------------------------------

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a learning path',
    description:
      'Admin groups related courses into an ordered learning path. ' +
      'The unique slug is auto-derived from the title. Optionally accepts an ' +
      'initial ordered course list whose order must respect prerequisites.',
  })
  create(
    @CurrentUser('id') adminId: string,
    @Body() dto: CreatePathDto,
  ) {
    return this.pathsService.create(adminId, dto);
  }

  // ----------------------------------------------------------
  // LIST — students see PUBLISHED only, admins see all
  // ----------------------------------------------------------

  @Get()
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({
    summary: 'List learning paths',
    description:
      'Paginated listing ordered newest first. Non-admin callers receive only ' +
      'PUBLISHED paths; admins may filter by ?status=DRAFT|PUBLISHED|ARCHIVED.',
  })
  findAll(
    @CurrentUser('role') role: UserRole,
    @Query() query: QueryPathsDto,
  ) {
    return this.pathsService.findAll(
      {
        page: query.page,
        limit: query.limit,
        search: query.search,
        status: query.status as LearningPathStatus | undefined,
      },
      role === UserRole.ADMIN,
    );
  }

  // ----------------------------------------------------------
  // GET ONE
  // ----------------------------------------------------------

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({ summary: 'Get learning path detail with its ordered courses' })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  findOne(@Param('id') id: string) {
    return this.pathsService.findOne(id);
  }

  // ----------------------------------------------------------
  // UPDATE / DELETE — admin only
  // ----------------------------------------------------------

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update title/description/cover of a learning path',
    description: 'The slug is regenerated when the title changes.',
  })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  update(@Param('id') id: string, @Body() dto: UpdatePathDto) {
    return this.pathsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a learning path',
    description: 'Removes the path; course associations are removed via CASCADE.',
  })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  remove(@Param('id') id: string) {
    return this.pathsService.remove(id);
  }

  // ----------------------------------------------------------
  // CURRICULUM BUILDER — replace the ordered course list
  // ----------------------------------------------------------

  @Put(':id/courses')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the ordered course list of a learning path',
    description:
      'Full replacement of the path curriculum. Array index defines course position. ' +
      'Validates that all courses are ACTIVE and that any prerequisite contained ' +
      'in the path appears earlier in the list. Returns 400 on violations.',
  })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  replaceCourses(@Param('id') id: string, @Body() dto: SetPathCoursesDto) {
    return this.pathsService.replaceCourses(id, dto.courseIds);
  }

  // ----------------------------------------------------------
  // PUBLISHING STATUS
  // ----------------------------------------------------------

  @Post(':id/publish')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a learning path',
    description:
      'Requires at least 2 courses and re-validates prerequisite ordering before publishing.',
  })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  publish(@Param('id') id: string) {
    return this.pathsService.publish(id);
  }

  @Post(':id/unpublish')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish a learning path back to DRAFT' })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  unpublish(@Param('id') id: string) {
    return this.pathsService.unpublish(id);
  }

  // ----------------------------------------------------------
  // STUDENT PROGRESS ACROSS THE PATH
  // ----------------------------------------------------------

  @Get(':id/progress')
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({
    summary: 'Get the current user’s progress across a learning path',
    description:
      'Per-course enrollment state, progress %, prerequisite satisfaction and an ' +
      'overall percentComplete plus the next available course to take.',
  })
  @ApiParam({ name: 'id', description: 'Learning path UUID' })
  getProgress(
    @CurrentUser('id') studentId: string,
    @Param('id') id: string,
  ) {
    return this.pathsService.getPathProgress(id, studentId);
  }
}
