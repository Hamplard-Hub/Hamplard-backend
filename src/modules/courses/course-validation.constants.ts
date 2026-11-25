/**
 * Shared validation rules for course input (issue #448).
 *
 * A course id becomes a public URL segment and the on-chain `course_id`, so it
 * must be short and URL-safe. Lowercase is allowed for compatibility with the
 * ids already seeded in the database (e.g. `course-tailoring-101`).
 */
export const COURSE_ID_PATTERN = /^[A-Za-z0-9-]{3,64}$/;

export const COURSE_ID_PATTERN_MESSAGE =
  'courseId must be 3-64 characters and contain only letters, digits and hyphens';

/**
 * Documented difficulty levels. Kept in sync with the `Course.level` column
 * comment in prisma/schema.prisma and with the `GET /courses` level filter.
 */
export const COURSE_LEVELS = ['Beginner', 'Intermediate', 'Advanced'] as const;

export type CourseLevel = (typeof COURSE_LEVELS)[number];

/**
 * Accepts both language names ("English") and BCP-47 style tags ("en", "en-US"),
 * while keeping the value safe to use in URLs and search filters.
 */
export const LANGUAGE_PATTERN = /^[A-Za-z]{2,35}(?:-[A-Za-z0-9]{2,8})*$/;

export const LANGUAGE_PATTERN_MESSAGE =
  'language must be a language name or tag (e.g. English or en-US) using only letters, digits and hyphens';
