import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ExamsService } from './exams.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { SubmitExamDto } from './dto/submit-exam.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('exams')
@Controller('exams')
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create or update exam for a course' })
  @Post()
  async createOrUpdateExam(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateExamDto,
  ) {
    return this.examsService.createOrUpdateExam(userId, dto);
  }

  @Get('course/:courseId')
  @ApiOperation({ summary: 'Get exam for a course' })
  async getExamByCourse(@Param('courseId') courseId: string) {
    return this.examsService.getExamByCourse(courseId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check exam eligibility for authenticated student' })
  @Get(':id/eligibility')
  async checkEligibility(
    @CurrentUser('id') userId: string,
    @Param('id') examId: string,
  ) {
    return this.examsService.checkEligibility(userId, examId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit an exam attempt' })
  @Post(':id/submit')
  async submitExam(
    @CurrentUser('id') userId: string,
    @Param('id') examId: string,
    @Body() dto: SubmitExamDto,
  ) {
    return this.examsService.submitExam(userId, examId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get exam attempt history' })
  @Get(':id/history')
  async getAttemptHistory(
    @CurrentUser('id') userId: string,
    @Param('id') examId: string,
  ) {
    return this.examsService.getAttemptHistory(userId, examId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete an exam' })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteExam(
    @Param('id') id: string,
    @CurrentUser() user: { id: string; role: UserRole },
  ) {
    return this.examsService.deleteExam(id, user.id, user.role);
  }
}
