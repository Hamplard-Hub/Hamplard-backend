import { Injectable, Logger } from '@nestjs/common';
import { CourseStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CourseSearchDocument, SearchService } from './search.service';

export interface ReindexResult {
  /** ACTIVE courses (re)written to the index. */
  indexed: number;
  /** Documents removed because the course is no longer ACTIVE (or no longer exists). */
  removed: number;
  /** Number of DB batches sent to Meilisearch. */
  batches: number;
  batchSize: number;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

/**
 * Issue #340 — rebuilds the Meilisearch `courses` index from the database.
 *
 * Courses are otherwise only indexed on approve/update, so a wiped index, an
 * outage during approval or a settings change leaves search out of sync. This
 * service re-applies the index settings, re-indexes every ACTIVE course in
 * batches and deletes documents whose course is no longer ACTIVE.
 */
@Injectable()
export class SearchReindexService {
  private readonly logger = new Logger(SearchReindexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly searchService: SearchService,
  ) {}

  async reindexAllCourses(batchSize = DEFAULT_BATCH_SIZE): Promise<ReindexResult> {
    const size = Math.min(Math.max(Math.floor(batchSize) || DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
    const startedAt = Date.now();

    await this.searchService.refreshIndexSettings();

    // Snapshot what is currently indexed before writing, so stale ids can be diffed out.
    const indexedIds = await this.searchService.listIndexedCourseIds(size);

    const activeIds = new Set<string>();
    let batches = 0;
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const courses = await this.prisma.course.findMany({
        where: { status: CourseStatus.ACTIVE },
        include: { instructor: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: size,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (courses.length === 0) break;

      await this.searchService.bulkIndexCourses(courses.map((course) => this.toDocument(course)));
      courses.forEach((course) => activeIds.add(course.id));
      batches += 1;
      cursor = courses[courses.length - 1].id;

      if (courses.length < size) break;
    }

    const staleIds = indexedIds.filter((id) => !activeIds.has(id));
    for (let i = 0; i < staleIds.length; i += size) {
      await this.searchService.removeCourses(staleIds.slice(i, i + size));
    }

    const result: ReindexResult = {
      indexed: activeIds.size,
      removed: staleIds.length,
      batches,
      batchSize: size,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Search reindex complete: indexed=${result.indexed} removed=${result.removed} ` +
      `batches=${result.batches} in ${result.durationMs}ms`,
    );
    return result;
  }

  private toDocument(course: {
    id: string;
    title: string;
    description: string | null;
    category: string;
    level: string;
    language: string;
    instructorAddress: string;
    instructor?: { name: string | null } | null;
    price: unknown;
    avgRating: number;
    totalEnrollments: number;
    totalReviews: number;
    thumbnailUrl: string | null;
    status: CourseStatus;
  }): CourseSearchDocument {
    return {
      id: course.id,
      title: course.title,
      description: course.description ?? '',
      category: course.category,
      level: course.level,
      language: course.language,
      instructorAddress: course.instructorAddress,
      instructorName: course.instructor?.name ?? '',
      price: Number(course.price),
      avgRating: course.avgRating,
      totalEnrollments: course.totalEnrollments,
      totalReviews: course.totalReviews,
      thumbnailUrl: course.thumbnailUrl ?? '',
      status: course.status,
      lastIndexedAt: 0, // set by searchService.bulkIndexCourses
    };
  }
}
