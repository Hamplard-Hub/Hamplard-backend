import { Test, TestingModule } from '@nestjs/testing';
import { DiscussionsController } from './discussions.controller';
import { CommentModerationService } from './comment-moderation.service';
import { DiscussionsService } from './discussions.service';
import { CommentQueryDto } from './dto/comment-query.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('DiscussionsController pagination (Issue #147)', () => {
  let controller: DiscussionsController;
  let commentModerationService: Partial<Record<keyof CommentModerationService, jest.Mock>>;

  beforeEach(async () => {
    commentModerationService = {
      findCommentsForDiscussion: jest.fn(),
      findFlaggedComments: jest.fn(),
      createComment: jest.fn(),
      findCommentById: jest.fn(),
      getModerationSummary: jest.fn(),
      moderateComment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiscussionsController],
      providers: [
        {
          provide: CommentModerationService,
          useValue: commentModerationService,
        },
        {
          provide: DiscussionsService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<DiscussionsController>(DiscussionsController);
  });

  describe('findCommentsForDiscussion', () => {
    it('passes discussionId and query pagination params to service', async () => {
      const mockResult = {
        data: [{ id: 'c1', content: 'test' }],
        meta: { total: 1, page: 2, limit: 10 },
      };
      (commentModerationService.findCommentsForDiscussion as jest.Mock).mockResolvedValue(mockResult);

      const query: CommentQueryDto = { page: 2, limit: 10 };
      const result = await controller.findCommentsForDiscussion('disc-1', query);

      expect(commentModerationService.findCommentsForDiscussion).toHaveBeenCalledWith('disc-1', 2, 10);
      expect(result).toEqual(mockResult);
    });

    it('handles query with undefined page and limit', async () => {
      const mockResult = {
        data: [],
        meta: { total: 0, page: 1, limit: 20 },
      };
      (commentModerationService.findCommentsForDiscussion as jest.Mock).mockResolvedValue(mockResult);

      const query: CommentQueryDto = {};
      const result = await controller.findCommentsForDiscussion('disc-1', query);

      expect(commentModerationService.findCommentsForDiscussion).toHaveBeenCalledWith('disc-1', undefined, undefined);
      expect(result).toEqual(mockResult);
    });
  });

  describe('findFlaggedComments', () => {
    it('passes query pagination params to service', async () => {
      const mockResult = {
        data: [{ id: 'c-flagged', content: 'bad content', flaggedCount: 1 }],
        meta: { total: 1, page: 3, limit: 15 },
      };
      (commentModerationService.findFlaggedComments as jest.Mock).mockResolvedValue(mockResult);

      const query: CommentQueryDto = { page: 3, limit: 15 };
      const result = await controller.findFlaggedComments(query);

      expect(commentModerationService.findFlaggedComments).toHaveBeenCalledWith(3, 15);
      expect(result).toEqual(mockResult);
    });

    it('handles query with undefined page and limit', async () => {
      const mockResult = {
        data: [],
        meta: { total: 0, page: 1, limit: 20 },
      };
      (commentModerationService.findFlaggedComments as jest.Mock).mockResolvedValue(mockResult);

      const query: CommentQueryDto = {};
      const result = await controller.findFlaggedComments(query);

      expect(commentModerationService.findFlaggedComments).toHaveBeenCalledWith(undefined, undefined);
      expect(result).toEqual(mockResult);
    });
  });

  describe('CommentQueryDto validation', () => {
    it('accepts valid page and limit', async () => {
      const dto = plainToInstance(CommentQueryDto, { page: '2', limit: '20' });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
      expect(dto.page).toBe(2);
      expect(dto.limit).toBe(20);
    });

    it('rejects page less than 1', async () => {
      const dto = plainToInstance(CommentQueryDto, { page: '0', limit: '20' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('page');
    });

    it('rejects limit exceeding maximum 100', async () => {
      const dto = plainToInstance(CommentQueryDto, { page: '1', limit: '101' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    });

    it('rejects limit less than 1', async () => {
      const dto = plainToInstance(CommentQueryDto, { page: '1', limit: '0' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    });
  });
});
