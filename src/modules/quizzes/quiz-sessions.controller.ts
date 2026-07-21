import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { QuizSessionsService } from './quiz-sessions.service';
import { StartQuizSessionDto, SubmitSessionAnswersDto } from './dto/quiz-sessions.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('quizzes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quizzes')
export class QuizSessionsController {
  constructor(private readonly quizSessionsService: QuizSessionsService) {}

  @Post('lessons/:lessonId/sessions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a timed quiz session for a lesson',
  })
  startSession(
    @Param('lessonId') lessonId: string,
    @Body() dto: StartQuizSessionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.quizSessionsService.startSession(lessonId, userId, dto);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({
    summary: 'Get remaining time status and session details',
  })
  getSessionStatus(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.quizSessionsService.getSessionStatus(sessionId, userId);
  }

  @Post('sessions/:sessionId/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit answers for a quiz session and calculate score',
  })
  submitSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: SubmitSessionAnswersDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.quizSessionsService.submitSession(sessionId, userId, dto);
  }

  @Post('sessions/:sessionId/auto-submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Auto-submit quiz session upon timer expiration',
  })
  autoSubmitSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: SubmitSessionAnswersDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.quizSessionsService.autoSubmitSession(sessionId, userId, dto);
  }
}
