-- Migration: add_tax_rates
-- Replaces hardcoded regional tax rates in FeeCalculatorService with an
-- admin-configurable table. Seeds the previously hardcoded values.

-- CreateTable
CREATE TABLE "tax_rates" (
    "id"          TEXT          NOT NULL,
    "region"      TEXT          NOT NULL,
    "ratePercent" DECIMAL(5,2)  NOT NULL,
    "description" TEXT,
    "isActive"    BOOLEAN       NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_region_key" ON "tax_rates"("region");

-- Seed previously hardcoded rates
INSERT INTO "tax_rates" ("id", "region", "ratePercent", "description", "updatedAt") VALUES
    (gen_random_uuid()::text, 'NG',      7.5, 'Nigeria VAT',                                  CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'US',      0,   'No federal sales tax on digital goods by default', CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'GB',      20,  'UK VAT',                                       CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'EU',      21,  'EU standard VAT (approximate)',                CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'DEFAULT', 0,   'Fallback for regions without a configured rate', CURRENT_TIMESTAMP);
