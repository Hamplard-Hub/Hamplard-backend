-- Migration: link_sessions_to_refresh_token_family
-- Issue #416 — Revoking a session does not revoke its refresh token

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "familyId" TEXT;

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");
