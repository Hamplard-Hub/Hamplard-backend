-- Migration: add_event_poller_checkpoint
-- Created for: Issue #80 — Persist last processed ledger for crash recovery

-- CreateTable: event_poller_checkpoints
CREATE TABLE "event_poller_checkpoints" (
    "id"                       TEXT         NOT NULL,
    "key"                      TEXT         NOT NULL,
    "lastProcessedLedger"      INTEGER      NOT NULL DEFAULT 0,
    "lastPolledAt"             TIMESTAMP(3),
    "lastWriteError"           TEXT,
    "consecutiveWriteFailures" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_poller_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_poller_checkpoints_key_key" ON "event_poller_checkpoints"("key");
