import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service';

@ApiTags('courses')
@Controller('courses/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('autocomplete')
  @ApiOperation({ summary: 'Get ranked autocomplete suggestions for course search' })
  @ApiQuery({ name: 'q', required: true, description: 'Partial course search query; minimum 2 characters' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum suggestions to return; capped at 25' })
  autocomplete(@Query('q') query: string, @Query('limit') limit?: number) {
    return this.searchService.autocomplete(query, limit);
  }
}
