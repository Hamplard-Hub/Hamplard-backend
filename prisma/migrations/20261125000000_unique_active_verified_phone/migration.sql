-- Fail rather than silently reassign ownership if existing active accounts
-- already share a verified number. Resolve those duplicates before deployment:
-- SELECT "phoneNumber", COUNT(*) FROM "users"
-- WHERE "isPhoneVerified" = true AND "deletedAt" IS NULL
--   AND "deactivatedAt" IS NULL AND "phoneNumber" IS NOT NULL
-- GROUP BY "phoneNumber" HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX "users_active_verified_phone_key"
ON "users" ("phoneNumber")
WHERE "isPhoneVerified" = true
  AND "deletedAt" IS NULL
  AND "deactivatedAt" IS NULL;
