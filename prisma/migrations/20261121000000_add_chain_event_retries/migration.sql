ALTER TYPE "AuditTargetType" ADD VALUE IF NOT EXISTS 'CERTIFICATE';

ALTER TABLE "chain_events"
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retryAt" TIMESTAMP(3);

CREATE INDEX "chain_events_processed_retryAt_attemptCount_idx"
ON "chain_events"("processed", "retryAt", "attemptCount");
