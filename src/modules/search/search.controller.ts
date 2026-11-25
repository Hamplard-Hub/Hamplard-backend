import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SearchService } from './search.service';
import { SearchReindexService } from './search-reindex.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { ReindexSearchDto } from './dto/reindex-search.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly reindexService: SearchReindexService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Full-text search across active courses',
    description:
      'Searches course titles and descriptions using Meilisearch. ' +
      'Results include highlighted matches. Supports filtering by category, level, and language. ' +
      'Query is sanitized for profanity. Results are ranked by relevance.',
  })
  search(@Query() query: SearchQueryDto) {
    return this.searchService.search({
      query: query.query,
      category: query.category,
      level: query.level,
      language: query.language,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Full-text search via POST (allows body for complex queries)',
  })
  searchPost(@Body() dto: SearchQueryDto) {
    return this.searchService.search({
      query: dto.query,
      category: dto.category,
      level: dto.level,
      language: dto.language,
      page: dto.page,
      limit: dto.limit,
    });
  }

  @Get('freshness/:courseId')
  @ApiOperation({
    summary: 'Check index freshness for a specific course',
    description:
      'Returns the timestamp (epoch ms) when the course was last indexed. ' +
      'Returns 0 if the course is not yet in the search index.',
  })
  async getFreshness(@Param('courseId') courseId: string) {
    const lastIndexedAt = await this.searchService.getIndexFreshness(courseId);
    return { courseId, lastIndexedAt, isFresh: lastIndexedAt > 0 };
  }

  @Post('reindex')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rebuild the course search index (admin only)',
    description:
      'Re-applies index settings, re-indexes every ACTIVE course in batches and removes ' +
      'documents for courses that are no longer ACTIVE. Returns indexed/removed counts. ' +
      'Also available as a CLI: `npm run search:reindex`.',
  })
  reindex(@Body() dto: ReindexSearchDto) {
    return this.reindexService.reindexAllCourses(dto?.batchSize);
  }
}
