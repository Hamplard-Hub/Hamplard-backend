import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CommentModerationService } from './comment-moderation.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ReviewCommentDto } from './dto/review-comment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('discussions')
@Controller('discussions')
export class DiscussionsController {
  constructor(private readonly commentModerationService: CommentModerationService) {}

  @Post('comments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a discussion comment and automatically scan it for banned content' })
  @HttpCode(HttpStatus.CREATED)
  createComment(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentModerationService.createComment(userId, dto);
  }

  @Get('comments/discussion/:discussionId')
  @ApiOperation({ summary: 'List visible comments for a discussion thread' })
  findCommentsForDiscussion(@Param('discussionId') discussionId: string) {
    return this.commentModerationService.findCommentsForDiscussion(discussionId);
  }

  @Get('comments/:id')
  @ApiOperation({ summary: 'Get a single discussion comment by ID' })
  findComment(@Param('id') id: string) {
    return this.commentModerationService.findCommentById(id);
  }

  @Get('moderation/flagged')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List flagged discussion comments awaiting moderation' })
  findFlaggedComments() {
    return this.commentModerationService.findFlaggedComments();
  }

  @Get('moderation/summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get discussion comment moderation summary' })
  getModerationSummary() {
    return this.commentModerationService.getModerationSummary();
  }

  @Patch('comments/:id/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Review a flagged discussion comment and update moderation status' })
  moderateComment(@Param('id') id: string, @Body() dto: ReviewCommentDto) {
    return this.commentModerationService.moderateComment(id, dto);
  }
}
