-- Migration: add_certificate_templates
-- Created for: Issue #95 — Certificate template customization API

CREATE TABLE "certificate_templates" (
    "id"          TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "category"    TEXT         NOT NULL,
    "branding"    JSONB        NOT NULL,
    "layout"      JSONB        NOT NULL,
    "signatures"  JSONB        NOT NULL,
    "isActive"    BOOLEAN      NOT NULL DEFAULT false,
    "createdById" TEXT         NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "certificate_templates_category_idx" ON "certificate_templates"("category");
CREATE INDEX "certificate_templates_category_isActive_idx" ON "certificate_templates"("category", "isActive");

-- At most one active template per course category (case-sensitive as stored).
CREATE UNIQUE INDEX "certificate_templates_one_active_per_category"
    ON "certificate_templates"("category")
    WHERE "isActive" = true;
