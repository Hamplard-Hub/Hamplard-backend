-- Issue #444: persist the latest admin rejection feedback on the course.
-- Nullable columns with no default: existing rows are untouched (NULL).
ALTER TABLE "courses"
ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3);
