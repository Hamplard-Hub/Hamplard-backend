import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { QuizzesService } from './quizzes.service';
import { CreateQuestionDto, UpdateQuestionDto, ReorderQuestionsDto } from './dto/create-question.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('quizzes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quizzes')
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  @Get('lessons/:lessonId/questions')
  @ApiOperation({ summary: 'Get all quiz questions for a lesson' })
  getQuestionsByLesson(@Param('lessonId') lessonId: string) {
    return this.quizzesService.getQuestionsByLesson(lessonId);
  }

  @Post('lessons/:lessonId/questions')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a quiz question for a lesson (instructor/admin)' })
  createQuestion(
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateQuestionDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.quizzesService.createQuestion(lessonId, dto, userId, userRole);
  }

  @Get('questions/:id')
  @ApiOperation({ summary: 'Get a specific quiz question by ID' })
  getQuestionById(@Param('id') id: string) {
    return this.quizzesService.getQuestionById(id);
  }

  @Patch('questions/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a quiz question by ID (instructor/admin)' })
  updateQuestion(
    @Param('id') id: string,
    @Body() dto: UpdateQuestionDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.quizzesService.updateQuestion(id, dto, userId, userRole);
  }

  @Delete('questions/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a quiz question by ID (instructor/admin)' })
  deleteQuestion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.quizzesService.deleteQuestion(id, userId, userRole);
  }

  @Patch('lessons/:lessonId/questions/reorder')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder questions within a lesson (instructor/admin)' })
  reorderQuestions(
    @Param('lessonId') lessonId: string,
    @Body() dto: ReorderQuestionsDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.quizzesService.reorderQuestions(lessonId, dto, userId, userRole);
  }
}
