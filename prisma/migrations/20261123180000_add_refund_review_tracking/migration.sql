ALTER TABLE "refunds"
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE INDEX "refunds_reviewedById_idx" ON "refunds"("reviewedById");

ALTER TABLE "refunds"
ADD CONSTRAINT "refunds_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
