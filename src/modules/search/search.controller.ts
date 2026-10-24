import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

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
}
