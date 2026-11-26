-- Issue #332: store price, platform fee, tax and discount on each enrollment
-- at purchase time so reports and payouts are not recomputed from the
-- current course.

-- AlterTable
ALTER TABLE "enrollments"
    ADD COLUMN "listPrice" DECIMAL(65,30),
    ADD COLUMN "platformFeeAmount" DECIMAL(65,30),
    ADD COLUMN "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    ADD COLUMN "discountAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    ADD COLUMN "discountSource" TEXT;

-- Backfill: snapshot the current course price. Anything paid above the list
-- price is treated as tax (checkout total = price + tax), anything below it
-- as a discount. The platform fee applies to the tax-exclusive amount using
-- the fee percent already snapshotted on the enrollment.
UPDATE "enrollments" e
SET
    "listPrice"         = c."price",
    "taxAmount"         = GREATEST(e."amountPaid" - c."price", 0),
    "discountAmount"    = GREATEST(c."price" - e."amountPaid", 0),
    "platformFeeAmount" = ROUND(LEAST(e."amountPaid", c."price") * e."platformFeePercent" / 100, 2)
FROM "courses" c
WHERE c."id" = e."courseId";

-- Backfill discount source: bundle purchases first, then referral rewards,
-- then coupons (most specific wins).
UPDATE "enrollments" e
SET "discountSource" = 'BUNDLE'
FROM "payments" p
WHERE p."txHash" = e."txHash"
  AND p."paymentType" = 'BUNDLE';

UPDATE "enrollments" e
SET "discountSource" = 'REFERRAL'
FROM "referral_rewards" r
WHERE r."enrollmentId" = e."id"
  AND r."status" = 'REDEEMED';

UPDATE "enrollments" e
SET
    "discountSource" = 'COUPON',
    "discountAmount" = cr."discount"
FROM "coupon_redemptions" cr
WHERE cr."userId" = e."studentId"
  AND cr."courseId" = e."courseId";
