import { Module } from '@nestjs/common';
import { QuizzesController } from './quizzes.controller';
import { QuizzesService } from './quizzes.service';
import { QuizAttemptsController } from './quiz-attempts.controller';
import { QuizAttemptsService } from './quiz-attempts.service';

@Module({
  controllers: [QuizzesController, QuizAttemptsController],
  providers: [QuizzesService, QuizAttemptsService],
  exports: [QuizzesService, QuizAttemptsService],
})
export class QuizzesModule {}

