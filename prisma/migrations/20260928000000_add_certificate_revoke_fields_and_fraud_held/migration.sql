-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CERTIFICATE_REVOKED';

-- AlterTable
ALTER TABLE "certificates" ADD COLUMN "revokedById" TEXT,
ADD COLUMN "revokedAt" TIMESTAMP(3),
ADD COLUMN "revokeReason" TEXT;

-- CreateIndex
CREATE INDEX "certificates_revokedById_idx" ON "certificates"("revokedById");

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "enrollment_fraud_flags" ALTER COLUMN "enrollmentId" DROP NOT NULL,
ADD COLUMN "blockedCourseId" TEXT,
ADD COLUMN "blockedAmountPaid" DECIMAL(65,30);
