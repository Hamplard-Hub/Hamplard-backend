-- Add phone OTP verification fields to User table
ALTER TABLE "users" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "users" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "users" ADD COLUMN "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);

-- Create OTP verification table
CREATE TABLE "phone_otp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_otp_pkey" PRIMARY KEY ("id")
);

-- Create indexes for performance
CREATE INDEX "phone_otp_userId_idx" ON "phone_otp"("userId");
CREATE INDEX "phone_otp_phoneNumber_idx" ON "phone_otp"("phoneNumber");
CREATE INDEX "phone_otp_expiresAt_idx" ON "phone_otp"("expiresAt");
CREATE INDEX "phone_otp_isUsed_idx" ON "phone_otp"("isUsed");

-- Add foreign key
ALTER TABLE "phone_otp" ADD CONSTRAINT "phone_otp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
