-- Add new AuditAction enum values
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KYC_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAYOUT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'COUPON_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CERTIFICATE_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CERTIFICATE_TX_HASH_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CERTIFICATE_REVOKED';

-- Add platformFeePercent to Enrollment table for fee snapshot
ALTER TABLE "enrollments" ADD COLUMN "platformFeePercent" INTEGER NOT NULL DEFAULT 20;

-- Update existing enrollments to have the current course fee
UPDATE "enrollments" e
SET "platformFeePercent" = c."platformFeePercent"
FROM "courses" c
WHERE e."courseId" = c.id;

-- Create index for revenue report queries
CREATE INDEX IF NOT EXISTS "idx_enrollments_revenue_report" ON "enrollments"(
  "status",
  "enrolledAt",
  "courseId"
);