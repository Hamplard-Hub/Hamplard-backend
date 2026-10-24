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
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CommentModerationService } from './comment-moderation.service';
import { DiscussionsService } from './discussions.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateAnswerDto } from './dto/create-answer.dto';
import { ThreadQueryDto } from './dto/thread-query.dto';
import { CommentQueryDto } from './dto/comment-query.dto';
import { ReviewCommentDto } from './dto/review-comment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('discussions')
@Controller('discussions')
export class DiscussionsController {
  constructor(
    private readonly commentModerationService: CommentModerationService,
    private readonly discussionsService: DiscussionsService,
  ) {}

  // ----------------------------------------------------------
  // LESSON Q&A THREADS
  // ----------------------------------------------------------

  @Post('lessons/:lessonId/questions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask a question on a lesson (enrolled students, instructor or admin)' })
  createQuestion(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: { id: string; role: UserRole },
    @Body() dto: CreateQuestionDto,
  ) {
    return this.discussionsService.createQuestion(lessonId, user.id, user.role, dto);
  }

  @Get('lessons/:lessonId/questions')
  @ApiOperation({ summary: 'List question threads for a lesson (paginated)' })
  listThreads(@Param('lessonId') lessonId: string, @Query() query: ThreadQueryDto) {
    return this.discussionsService.listThreads(lessonId, query.page, query.limit);
  }

  @Get('questions/:questionId')
  @ApiOperation({ summary: 'Get a question with its answer thread (paginated answers)' })
  getThread(@Param('questionId') questionId: string, @Query() query: ThreadQueryDto) {
    return this.discussionsService.getThread(questionId, query.page, query.limit);
  }

  @Post('questions/:questionId/answers')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Answer a question (enrolled students, instructor or admin)' })
  createAnswer(
    @Param('questionId') questionId: string,
    @CurrentUser() user: { id: string; role: UserRole },
    @Body() dto: CreateAnswerDto,
  ) {
    return this.discussionsService.createAnswer(questionId, user.id, user.role, dto);
  }

  @Patch('answers/:answerId/best')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark an answer as the best answer (course instructor or admin)' })
  markBestAnswer(
    @Param('answerId') answerId: string,
    @CurrentUser() user: { id: string; role: UserRole },
  ) {
    return this.discussionsService.markBestAnswer(answerId, user.id, user.role);
  }

  // ----------------------------------------------------------
  // COMMENTS & MODERATION
  // ----------------------------------------------------------

  @Post('comments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a discussion comment and automatically scan it for banned content' })
  @HttpCode(HttpStatus.CREATED)
  createComment(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentModerationService.createComment(userId, dto, role);
  }

  @Get('comments/discussion/:discussionId')
  @ApiOperation({ summary: 'List visible comments for a discussion thread' })
  findCommentsForDiscussion(
    @Param('discussionId') discussionId: string,
    @Query() query: CommentQueryDto,
  ) {
    return this.commentModerationService.findCommentsForDiscussion(
      discussionId,
      query.page,
      query.limit,
    );
  }

  @Get('comments/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get a single discussion comment by ID (hidden/rejected comments are admin-only)' })
  findComment(
    @Param('id') id: string,
    @CurrentUser('role') role?: UserRole,
  ) {
    return this.commentModerationService.findCommentById(id, role);
  }

  @Get('moderation/flagged')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List flagged discussion comments awaiting moderation' })
  findFlaggedComments(@Query() query: CommentQueryDto) {
    return this.commentModerationService.findFlaggedComments(query.page, query.limit);
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
