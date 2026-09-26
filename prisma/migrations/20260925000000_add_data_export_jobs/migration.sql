-- Migration: add_data_export_jobs
-- Created for: Issue #73 - Create GDPR data export API

-- CreateTable
CREATE TABLE "data_export_jobs" (
    "id"             TEXT        NOT NULL,
    "userId"         TEXT        NOT NULL,
    "status"         TEXT        NOT NULL DEFAULT 'PENDING',
    "payload"        JSONB,
    "fileSizeBytes"  INTEGER,
    "checksum"       TEXT,
    "errorMessage"   TEXT,
    "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"      TIMESTAMP(3),
    "completedAt"    TIMESTAMP(3),
    "expiresAt"      TIMESTAMP(3),
    "downloadCount"  INTEGER     NOT NULL DEFAULT 0,
    "lastDownloadAt" TIMESTAMP(3),

    CONSTRAINT "data_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_export_jobs_userId_idx" ON "data_export_jobs"("userId");
CREATE INDEX "data_export_jobs_status_idx" ON "data_export_jobs"("status");
CREATE INDEX "data_export_jobs_expiresAt_idx" ON "data_export_jobs"("expiresAt");

-- AddForeignKey
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
