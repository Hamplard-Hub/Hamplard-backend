import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchReindexService } from './search-reindex.service';

@Module({
  imports: [ConfigModule],
  controllers: [SearchController],
  providers: [SearchService, SearchReindexService],
  exports: [SearchService, SearchReindexService],
})
export class SearchModule {}
