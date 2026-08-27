-- CreateEnum
CREATE TYPE "CourseRestoreStatus" AS ENUM ('PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "course_restore_jobs" (
    "id" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "CourseRestoreStatus" NOT NULL DEFAULT 'PENDING',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "totalSteps" INTEGER NOT NULL DEFAULT 0,
    "completedSteps" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "backupPayload" JSONB NOT NULL,
    "validationErrors" JSONB,
    "summary" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_restore_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_restore_jobs_status_idx" ON "course_restore_jobs"("status");

-- CreateIndex
CREATE INDEX "course_restore_jobs_scheduledFor_idx" ON "course_restore_jobs"("scheduledFor");

-- CreateIndex
CREATE INDEX "course_restore_jobs_requestedBy_idx" ON "course_restore_jobs"("requestedBy");

-- AddForeignKey
ALTER TABLE "course_restore_jobs" ADD CONSTRAINT "course_restore_jobs_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
