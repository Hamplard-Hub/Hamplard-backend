-- Migration: add_sessions
-- Created for: Issue #69 — Session and device management API

CREATE TABLE "sessions" (
    "id"           TEXT         NOT NULL,
    "userId"       TEXT         NOT NULL,
    "jti"          TEXT         NOT NULL,
    "deviceLabel"  TEXT,
    "userAgent"    TEXT,
    "ipAddress"    TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "revokedAt"    TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_jti_key" ON "sessions"("jti");
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
