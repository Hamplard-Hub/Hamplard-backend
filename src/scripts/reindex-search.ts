/**
 * Issue #340 — CLI to rebuild the Meilisearch course index.
 *
 *   npm run search:reindex            # default batch size (500)
 *   npm run search:reindex -- 1000    # custom batch size
 *
 * Boots only the modules the reindex needs (config, Prisma, search) so no
 * HTTP server, queues or cron jobs are started.
 */
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../common/prisma/prisma.module';
import { SearchModule } from '../modules/search/search.module';
import { SearchReindexService } from '../modules/search/search-reindex.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, SearchModule],
})
class ReindexSearchModule {}

async function main() {
  const logger = new Logger('SearchReindex');
  const batchSizeArg = process.argv[2] ? Number(process.argv[2]) : undefined;

  const app = await NestFactory.createApplicationContext(ReindexSearchModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const result = await app.get(SearchReindexService).reindexAllCourses(batchSizeArg);
    logger.log(
      `Indexed ${result.indexed} ACTIVE courses, removed ${result.removed} stale documents ` +
      `(${result.batches} batches of up to ${result.batchSize}, ${result.durationMs}ms)`,
    );
    process.exitCode = 0;
  } catch (err) {
    logger.error(`Search reindex failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
