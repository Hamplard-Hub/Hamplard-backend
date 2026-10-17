-- Server-stored quiz pass threshold and attempt policy on lessons (#236, #238)

-- AlterTable
ALTER TABLE "lessons" ADD COLUMN "passThreshold" INTEGER NOT NULL DEFAULT 70;
ALTER TABLE "lessons" ADD COLUMN "maxAttempts" INTEGER;
ALTER TABLE "lessons" ADD COLUMN "attemptCooldownMinutes" INTEGER NOT NULL DEFAULT 0;
