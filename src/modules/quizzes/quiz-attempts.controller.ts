import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { QuizAttemptsService } from './quiz-attempts.service';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('quizzes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quizzes')
export class QuizAttemptsController {
  constructor(private readonly quizAttemptsService: QuizAttemptsService) {}

  @Post('lessons/:lessonId/attempts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a quiz attempt for a lesson and calculate score',
  })
  submitQuizAttempt(
    @Param('lessonId') lessonId: string,
    @Body() dto: SubmitQuizAttemptDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.quizAttemptsService.submitQuizAttempt(lessonId, dto, userId);
  }
}
