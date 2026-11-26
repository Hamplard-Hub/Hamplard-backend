-- Migration: add_checkout_quotes (issues #333, #334)
-- Server-priced, signed checkout quotes plus a price snapshot on enrollments
-- so invoices can itemise subtotal, discounts and tax.

-- CreateTable
CREATE TABLE "checkout_quotes" (
    "id"               TEXT             NOT NULL,
    "studentId"        TEXT             NOT NULL,
    "courseId"         TEXT             NOT NULL,
    "currency"         TEXT             NOT NULL DEFAULT 'USDC',
    "listPrice"        DECIMAL(65,30)   NOT NULL,
    "couponId"         TEXT,
    "couponCode"       TEXT,
    "couponDiscount"   DECIMAL(65,30)   NOT NULL DEFAULT 0,
    "referralRewardId" TEXT,
    "referralDiscount" DECIMAL(65,30)   NOT NULL DEFAULT 0,
    "subtotal"         DECIMAL(65,30)   NOT NULL,
    "taxRegion"        TEXT             NOT NULL,
    "taxRatePercent"   DECIMAL(65,30)   NOT NULL,
    "taxAmount"        DECIMAL(65,30)   NOT NULL,
    "total"            DECIMAL(65,30)   NOT NULL,
    "signature"        TEXT             NOT NULL,
    "expiresAt"        TIMESTAMP(3)     NOT NULL,
    "consumedAt"       TIMESTAMP(3),
    "enrollmentId"     TEXT,
    "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_quotes_enrollmentId_key" ON "checkout_quotes"("enrollmentId");
CREATE INDEX "checkout_quotes_studentId_courseId_idx" ON "checkout_quotes"("studentId", "courseId");
CREATE INDEX "checkout_quotes_expiresAt_idx" ON "checkout_quotes"("expiresAt");

-- AlterTable: enrollment price snapshot
ALTER TABLE "enrollments"
ADD COLUMN "listPrice"        DECIMAL(65,30),
ADD COLUMN "couponDiscount"   DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "referralDiscount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "taxRegion"        TEXT,
ADD COLUMN "taxRatePercent"   DECIMAL(65,30),
ADD COLUMN "taxAmount"        DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "couponId"         TEXT,
ADD COLUMN "referralRewardId" TEXT,
ADD COLUMN "checkoutQuoteId"  TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_checkoutQuoteId_key" ON "enrollments"("checkoutQuoteId");
