ALTER TABLE "sessions"
ADD COLUMN "refreshFamilyId" TEXT;

CREATE INDEX "sessions_refreshFamilyId_idx" ON "sessions"("refreshFamilyId");
