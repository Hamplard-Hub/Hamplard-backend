import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { QuestionsService } from './questions.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateAnswerDto } from './dto/create-answer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('lesson-qa')
@Controller()
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post('lessons/:lessonId/questions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask a question on a lesson' })
  async createQuestion(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: { id: string; role: UserRole },
    @Body() dto: CreateQuestionDto,
  ) {
    return this.questionsService.createQuestion(
      lessonId,
      user.id,
      user.role,
      dto,
    );
  }

  @Get('lessons/:lessonId/questions')
  @ApiOperation({ summary: 'List questions for a lesson (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getQuestions(
    @Param('lessonId') lessonId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.questionsService.getQuestionsByLesson(
      lessonId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Post('questions/:id/answers')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Answer a question' })
  async createAnswer(
    @Param('id') questionId: string,
    @CurrentUser() user: { id: string; role: UserRole },
    @Body() dto: CreateAnswerDto,
  ) {
    return this.questionsService.createAnswer(
      questionId,
      user.id,
      user.role,
      dto,
    );
  }

  @Patch('answers/:id/best')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an answer as the best answer (question author or admin)' })
  async markBestAnswer(
    @Param('id') answerId: string,
    @CurrentUser() user: { id: string; role: UserRole },
  ) {
    return this.questionsService.markBestAnswer(answerId, user.id, user.role);
  }
}
