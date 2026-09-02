-- Migration: add_wishlist_items
-- Created for: Issue #22 - Create course wishlist API

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id"             TEXT         NOT NULL,
    "studentId"      TEXT         NOT NULL,
    "courseId"       TEXT         NOT NULL,
    "lastReminderAt" TIMESTAMP(3),
    "reminderCount"  INTEGER      NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_items_studentId_courseId_key" ON "wishlist_items"("studentId", "courseId");
CREATE INDEX "wishlist_items_studentId_idx" ON "wishlist_items"("studentId");

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
