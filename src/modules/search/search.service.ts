import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch } from 'meilisearch';
import Filter from 'bad-words';

/**
 * Interface representing a course document stored in the Meilisearch index.
 */
export interface CourseSearchDocument {
  id: string;
  title: string;
  description: string;
  category: string;
  level: string;
  language: string;
  instructorAddress: string;
  instructorName: string;
  price: number;
  avgRating: number;
  totalEnrollments: number;
  totalReviews: number;
  thumbnailUrl: string;
  status: string;
  lastIndexedAt: number; // epoch ms — tracks index freshness per course
}

export interface SearchResult {
  hits: CourseSearchDocument[];
  estimatedTotalHits: number;
  page: number;
  limit: number;
  totalPages: number;
  query: string;
  processingTimeMs: number;
}

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);

  private readonly client: MeiliSearch;
  private readonly indexName = 'courses';
  private readonly profanityFilter: Filter;

  /** Ranking-score weights applied to course documents at index time.
   *  Meilisearch uses these built-in ranking rules by default, but we
   *  configure dedicated attributes for relevance: title gets higher
   *  weight via the `words` and `typo` rules, and we sort by
   *  avgRating and totalEnrollments as tie-breakers. */
  private readonly rankingRules = [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
  ];

  /** Attributes whose content will be highlighted in search responses. */
  private readonly attributesToHighlight = ['title', 'description'];

  /** Attributes that are searchable (full-text indexed). */
  private readonly searchableAttributes = [
    'title',
    'description',
    'category',
    'level',
    'language',
    'instructorName',
  ];

  /** Attributes returned in search results. */
  private readonly displayedAttributes = [
    'id',
    'title',
    'description',
    'category',
    'level',
    'language',
    'instructorAddress',
    'instructorName',
    'price',
    'avgRating',
    'totalEnrollments',
    'totalReviews',
    'thumbnailUrl',
    'status',
    'lastIndexedAt',
  ];

  /** Attributes available for sorting. */
  private readonly sortableAttributes = [
    'avgRating',
    'totalEnrollments',
    'price',
    'lastIndexedAt',
  ];

  /** Attributes used for filtering. */
  private readonly filterableAttributes = [
    'category',
    'level',
    'language',
    'status',
  ];

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>(
      'MEILISEARCH_HOST',
      'http://localhost:7700',
    );
    const apiKey = this.config.get<string>('MEILISEARCH_API_KEY', '');

    this.client = new MeiliSearch({ host, apiKey });
    this.profanityFilter = new Filter();
  }

  // ---------------------------------------------------------------
  // LIFECYCLE
  // ---------------------------------------------------------------

  async onModuleInit() {
    try {
      await this.ensureIndex();
      this.logger.log(`Meilisearch index "${this.indexName}" is ready`);
    } catch (err) {
      this.logger.error(
        `Failed to initialise Meilisearch index: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    // No explicit teardown needed; connection is HTTP-based.
  }

  // ---------------------------------------------------------------
  // INDEX MANAGEMENT
  // ---------------------------------------------------------------

  /**
   * Ensures the courses index exists with the desired settings.
   * Updates settings if the index already exists.
   */
  private async ensureIndex() {
    const index = this.client.index(this.indexName);

    // Try to fetch the index; create if it doesn't exist.
    try {
      await index.getRawInfo();
    } catch {
      await this.client.createIndex(this.indexName, { primaryKey: 'id' });
    }

    // Apply index settings for relevance ranking, filters, searchable attrs, etc.
    await index.updateSettings({
      searchableAttributes: this.searchableAttributes,
      displayedAttributes: this.displayedAttributes,
      filterableAttributes: this.filterableAttributes,
      sortableAttributes: this.sortableAttributes,
      rankingRules: this.rankingRules,
    });
  }

  // ---------------------------------------------------------------
  // DOCUMENT SYNC
  // ---------------------------------------------------------------

  /**
   * Indexes (adds or replaces) a single course document.
   * Called whenever a course is created, updated, approved, or otherwise
   * changes state so the search index stays fresh.
   */
  async indexCourse(doc: CourseSearchDocument): Promise<void> {
    const timestamped = { ...doc, lastIndexedAt: Date.now() };
    await this.client.index(this.indexName).addDocuments([timestamped]);
    this.logger.debug(`Indexed course ${doc.id}: "${doc.title}"`);
  }

  /**
   * Removes a course from the search index (e.g. when archived).
   */
  async removeCourse(courseId: string): Promise<void> {
    await this.client.index(this.indexName).deleteDocument(courseId);
    this.logger.debug(`Removed course ${courseId} from search index`);
  }

  /**
   * Bulk-reindexes all active courses. Useful for a one-time initial sync
   * or after index settings change.
   */
  async bulkIndexCourses(docs: CourseSearchDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const timestamped = docs.map((d) => ({ ...d, lastIndexedAt: Date.now() }));
    await this.client.index(this.indexName).addDocuments(timestamped);
    this.logger.log(`Bulk-indexed ${docs.length} courses`);
  }

  /**
   * Returns the timestamp of the last index update for a course.
   * Returns 0 if the course is not indexed.
   */
  async getIndexFreshness(courseId: string): Promise<number> {
    try {
      const doc = await this.client
        .index(this.indexName)
        .getDocument<CourseSearchDocument>(courseId);
      return doc.lastIndexedAt ?? 0;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------------

  /**
   * Performs a full-text search against Meilisearch with optional filters.
   *
   * Query sanitisation:
   * - Rejects empty/whitespace-only queries.
   * - Applies profanity filtering (bad-words) to the query string.
   * - Relies on Meilisearch's built-in query parsing to handle special
   *   characters safely (injection resistance via its HTTP API).
   *
   * Relevance ranking uses the configured ranking rules (words → typo →
   * proximity → attribute → sort → exactness) which are applied
   * automatically by Meilisearch.
   */
  async search(params: {
    query: string;
    category?: string;
    level?: string;
    language?: string;
    page?: number;
    limit?: number;
  }): Promise<SearchResult> {
    const {
      query,
      category,
      level,
      language,
      page = 1,
      limit = 20,
    } = params;

    // ----------------------------------------------------------
    // 1. Sanitize: reject empty queries, filter profanity
    // ----------------------------------------------------------
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) {
      return {
        hits: [],
        estimatedTotalHits: 0,
        page,
        limit,
        totalPages: 0,
        query,
        processingTimeMs: 0,
      };
    }

    // ----------------------------------------------------------
    // 2. Build filters
    // ----------------------------------------------------------
    const filters: string[] = ['status = ACTIVE'];
    if (category) filters.push(`category = ${this.escapeFilterValue(category)}`);
    if (level) filters.push(`level = ${this.escapeFilterValue(level)}`);
    if (language) filters.push(`language = ${this.escapeFilterValue(language)}`);

    const filterExpression = filters.join(' AND ');

    // ----------------------------------------------------------
    // 3. Execute search with highlights
    // ----------------------------------------------------------
    const startTime = Date.now();
    const result = await this.client.index(this.indexName).search(sanitized, {
      filter: filterExpression,
      limit,
      offset: (page - 1) * limit,
      attributesToHighlight: this.attributesToHighlight,
      showMatchesPosition: true,
      sort: ['avgRating:desc'],
    });
    const processingTimeMs = Date.now() - startTime;

    // ----------------------------------------------------------
    // 4. Map response
    // ----------------------------------------------------------
    const hits = (result.hits ?? []) as unknown as CourseSearchDocument[];
    const estimatedTotalHits = result.estimatedTotalHits ?? hits.length;
    const totalPages = Math.max(1, Math.ceil(estimatedTotalHits / limit));

    return {
      hits,
      estimatedTotalHits,
      page,
      limit,
      totalPages,
      query: sanitized,
      processingTimeMs,
    };
  }

  // ---------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------

  /**
   * Sanitizes a search query string.
   * - Trims whitespace.
   * - Returns empty string if the query is empty or only whitespace.
   * - Filters profanity using bad-words library.
   */
  private sanitizeQuery(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';

    // Filter profanity (bad-words replaces bad words with ***)
    return this.profanityFilter.clean(trimmed);
  }

  /**
   * Escapes a filter value for safe use in Meilisearch filter expressions.
   * Wraps the value in double quotes and escapes any embedded double quotes.
   */
  private escapeFilterValue(value: string): string {
    const escaped = value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
}
