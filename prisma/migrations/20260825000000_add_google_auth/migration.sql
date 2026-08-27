-- Allow users to authenticate without a Stellar wallet and track Google identities.
ALTER TABLE "users" ALTER COLUMN "stellarAddress" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");