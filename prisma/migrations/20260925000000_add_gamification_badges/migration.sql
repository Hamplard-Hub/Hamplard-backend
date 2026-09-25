-- CreateEnum
CREATE TYPE "BadgeRequirementType" AS ENUM ('LESSONS_COMPLETED', 'COURSES_COMPLETED', 'POINTS_EARNED');

-- CreateTable
CREATE TABLE "badges" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "requirementType" "BadgeRequirementType" NOT NULL,
    "requirementValue" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_badges" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "badges_code_key" ON "badges"("code");
CREATE INDEX "badges_isActive_idx" ON "badges"("isActive");
CREATE UNIQUE INDEX "student_badges_studentId_badgeId_key" ON "student_badges"("studentId", "badgeId");
CREATE INDEX "student_badges_studentId_awardedAt_idx" ON "student_badges"("studentId", "awardedAt");

-- AddForeignKey
ALTER TABLE "student_badges" ADD CONSTRAINT "student_badges_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_badges" ADD CONSTRAINT "student_badges_badgeId_fkey"
    FOREIGN KEY ("badgeId") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
