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
  @ApiQuery({ name: 'query', required: true, description: 'Full-text search query' })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category' })
  @ApiQuery({ name: 'level', required: false, description: 'Filter by level (Beginner, Intermediate, Advanced)' })
  @ApiQuery({ name: 'language', required: false, description: 'Filter by language' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  search(
    @Query('query') query: string,
    @Query('category') category?: string,
    @Query('level') level?: string,
    @Query('language') language?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.searchService.search({
      query,
      category,
      level,
      language,
      page: page ?? 1,
      limit: limit ?? 20,
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
