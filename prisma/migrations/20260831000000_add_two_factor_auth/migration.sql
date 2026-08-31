-- Migration: add_two_factor_auth
-- Created for: Issue #68 — Two-factor authentication (2FA) setup API

-- AlterTable
ALTER TABLE "users" ADD COLUMN "twoFactorSecret" TEXT,
ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "twoFactorEnabledAt" TIMESTAMP(3),
ADD COLUMN "twoFactorRecoveryCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
