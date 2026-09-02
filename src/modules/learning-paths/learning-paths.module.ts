import { Module } from '@nestjs/common';
import { LearningPathsController } from './learning-paths.controller';
import { LearningPathsService } from './learning-paths.service';

@Module({
  controllers: [LearningPathsController],
  providers: [LearningPathsService],
  exports: [LearningPathsService],
})
export class LearningPathsModule {}
