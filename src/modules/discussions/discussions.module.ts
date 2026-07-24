import { Module } from '@nestjs/common';
import { DiscussionsController } from './discussions.controller';
import { CommentModerationService } from './comment-moderation.service';

@Module({
  controllers: [DiscussionsController],
  providers: [CommentModerationService],
  exports: [CommentModerationService],
})
export class DiscussionsModule {}
