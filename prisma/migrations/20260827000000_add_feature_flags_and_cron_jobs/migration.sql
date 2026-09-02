-- Migration: add_feature_flags_and_cron_jobs
-- Adds FeatureFlag and CronJobRun models

-- FeatureFlag: stores named feature toggles with optional rollout percentage
CREATE TABLE "feature_flags" (
    "id"               TEXT NOT NULL,
    "key"              TEXT NOT NULL,
    "description"      TEXT,
    "enabled"          BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent"   INTEGER NOT NULL DEFAULT 100,
    "allowedRoles"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedUserIds"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata"         JSONB,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CronJobRun: one row per execution of a named cron job
CREATE TYPE "CronJobStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');

CREATE TABLE "cron_job_runs" (
    "id"          TEXT NOT NULL,
    "jobName"     TEXT NOT NULL,
    "status"      "CronJobStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"  TIMESTAMP(3),
    "durationMs"  INTEGER,
    "message"     TEXT,
    "error"       TEXT,
    "metadata"    JSONB,

    CONSTRAINT "cron_job_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cron_job_runs_jobName_idx"   ON "cron_job_runs"("jobName");
CREATE INDEX "cron_job_runs_startedAt_idx" ON "cron_job_runs"("startedAt");
CREATE INDEX "cron_job_runs_status_idx"    ON "cron_job_runs"("status");
