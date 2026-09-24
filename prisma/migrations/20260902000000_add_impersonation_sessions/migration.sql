-- AddImpersonationSession
-- Adds ImpersonationSession model for persistent impersonation session storage

-- Create enum if not exists
DO $$ BEGIN
    CREATE TYPE "ImpersonationSessionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'ENDED', 'FORCE_ENDED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create impersonation_sessions table
CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "reason" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "ImpersonationSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "forceEndedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "impersonation_sessions_adminId_idx" ON "impersonation_sessions"("adminId");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_targetUserId_idx" ON "impersonation_sessions"("targetUserId");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_status_idx" ON "impersonation_sessions"("status");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_expiresAt_idx" ON "impersonation_sessions"("expiresAt");

-- Add unique constraint on sessionId
DO $$ BEGIN
    ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_sessionId_key" UNIQUE ("sessionId");
EXCEPTION
    WHEN duplicate_constraint THEN null;
END $$;