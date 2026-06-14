import {
  Controller, Get, Post, Patch, Body, Param,
  Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CourseStatus, UserRole } from '@prisma/client';

@ApiTags('courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  // ----------------------------------------------------------
  // PUBLIC ROUTES — no auth needed for browsing
  // ----------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'Browse active courses with filters' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'level',    required: false })
  @ApiQuery({ name: 'search',   required: false })
  @ApiQuery({ name: 'page',     required: false, type: Number })
  @ApiQuery({ name: 'limit',    required: false, type: Number })
  findAll(
    @Query('category') category?: string,
    @Query('level')    level?: string,
    @Query('search')   search?: string,
    @Query('page')     page?: number,
    @Query('limit')    limit?: number,
  ) {
    return this.coursesService.findAll({
      category, level, search, page, limit,
      status: CourseStatus.ACTIVE,
    });
  }

  @Get('categories')
  @ApiOperation({ summary: 'List all course categories with counts' })
  getCategories() { return this.coursesService.getCategories(); }

  @Get(':id')
  @ApiOperation({ summary: 'Get full course detail including modules and lessons' })
  findOne(@Param('id') id: string) { return this.coursesService.findOne(id); }

  // ----------------------------------------------------------
  // INSTRUCTOR ROUTES
  // ----------------------------------------------------------

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Instructor creates a course draft' })
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('stellarAddress') address: string,
    @Body() dto: CreateCourseDto,
  ) {
    return this.coursesService.create(userId, address, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update course details (instructor)' })
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCourseDto,
  ) {
    return this.coursesService.update(id, userId, dto);
  }

  @Post(':id/submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit course for admin review (after on-chain registration)' })
  submitForReview(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { txHash?: string },
  ) {
    return this.coursesService.submitForReview(id, userId, body.txHash);
  }

  // ----------------------------------------------------------
  // ADMIN ROUTES
  // ----------------------------------------------------------

  @Get('admin/pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all pending courses awaiting approval' })
  getPending() {
    return this.coursesService.findAll({ status: CourseStatus.PENDING });
  }

  @Post(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin approves a pending course' })
  approve(@Param('id') id: string, @CurrentUser('id') adminId: string) {
    return this.coursesService.approve(id, adminId);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin rejects a pending course with feedback' })
  reject(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() body: { reason: string },
  ) {
    return this.coursesService.reject(id, adminId, body.reason);
  }
}
