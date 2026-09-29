-- Persist referral reward rules, quiz attempts, and quiz sessions (#166, #167, #169, #170)

-- CreateEnum
CREATE TYPE "QuizSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'EXPIRED');

-- CreateTable: referral_reward_rules (singleton row, id = 'default')
CREATE TABLE "referral_reward_rules" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "referrerDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "refereeDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "rewardExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "maxRewardsPerReferrer" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_reward_rules_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row with the current .env-based defaults
INSERT INTO "referral_reward_rules" ("id", "referrerDiscountPercent", "refereeDiscountPercent", "rewardExpiryDays", "maxRewardsPerReferrer", "createdAt", "updatedAt")
VALUES ('default', 10, 10, 90, 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- CreateTable: quiz_attempts
CREATE TABLE "quiz_attempts" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "answers" JSONB,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_attempts_lessonId_studentId_idx" ON "quiz_attempts"("lessonId", "studentId");
CREATE INDEX "quiz_attempts_studentId_idx" ON "quiz_attempts"("studentId");

-- CreateTable: quiz_sessions
CREATE TABLE "quiz_sessions" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSeconds" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "QuizSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "result" JSONB,
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_sessions_userId_idx" ON "quiz_sessions"("userId");
CREATE INDEX "quiz_sessions_status_expiresAt_idx" ON "quiz_sessions"("status", "expiresAt");
CREATE INDEX "quiz_sessions_lessonId_idx" ON "quiz_sessions"("lessonId");

-- AddForeignKey: quiz_attempts
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: quiz_sessions
ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
