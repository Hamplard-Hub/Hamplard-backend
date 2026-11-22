-- Issues #74 / #75: account deactivation and GDPR deletion markers
ALTER TABLE "users" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMP(3);
