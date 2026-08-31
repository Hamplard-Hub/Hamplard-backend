-- Shareable public certificate links and their view counters.
CREATE TABLE "certificate_shares" (
    "id"            TEXT         NOT NULL,
    "certificateId" TEXT         NOT NULL,
    "token"         TEXT         NOT NULL,
    "viewCount"     INTEGER      NOT NULL DEFAULT 0,
    "lastViewedAt"  TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "certificate_shares_certificateId_key"
    ON "certificate_shares"("certificateId");
CREATE UNIQUE INDEX "certificate_shares_token_key"
    ON "certificate_shares"("token");

ALTER TABLE "certificate_shares"
    ADD CONSTRAINT "certificate_shares_certificateId_fkey"
    FOREIGN KEY ("certificateId") REFERENCES "certificates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
