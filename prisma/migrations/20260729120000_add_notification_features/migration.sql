CREATE TABLE "notification_device_tokens" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "platform" TEXT DEFAULT 'mobile',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "email" BOOLEAN NOT NULL DEFAULT true,
  "push" BOOLEAN NOT NULL DEFAULT true,
  "inApp" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_digest_preferences" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastDigestAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_digest_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_device_tokens_token_key" ON "notification_device_tokens"("token");
CREATE INDEX "notification_device_tokens_userId_idx" ON "notification_device_tokens"("userId");
CREATE INDEX "notification_device_tokens_isActive_idx" ON "notification_device_tokens"("isActive");
CREATE UNIQUE INDEX "notification_preferences_userId_type_key" ON "notification_preferences"("userId", "type");
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");
CREATE UNIQUE INDEX "notification_digest_preferences_userId_key" ON "notification_digest_preferences"("userId");

ALTER TABLE "notification_device_tokens"
  ADD CONSTRAINT "notification_device_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_digest_preferences"
  ADD CONSTRAINT "notification_digest_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
