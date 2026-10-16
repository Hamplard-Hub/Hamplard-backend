-- Migration: persist admin rejection reason on Course record
-- Issue: #146

-- AlterTable
ALTER TABLE "courses" ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3);
