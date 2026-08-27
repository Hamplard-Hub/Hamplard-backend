-- Migration: add_tag_management
-- Created for: Issue #47 — Tag management CRUD API

-- CreateTable: tags
CREATE TABLE "tags" (
    "id"         TEXT         NOT NULL,
    "name"       TEXT         NOT NULL,
    "label"      TEXT         NOT NULL,
    "usageCount" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable: course_tags  (join table)
CREATE TABLE "course_tags" (
    "id"       TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "tagId"    TEXT NOT NULL,

    CONSTRAINT "course_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");
CREATE INDEX "tags_usageCount_idx" ON "tags"("usageCount");
CREATE INDEX "tags_name_idx" ON "tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "course_tags_courseId_tagId_key" ON "course_tags"("courseId", "tagId");
CREATE INDEX "course_tags_courseId_idx" ON "course_tags"("courseId");
CREATE INDEX "course_tags_tagId_idx" ON "course_tags"("tagId");

-- AddForeignKey: course_tags.courseId → courses.id
ALTER TABLE "course_tags"
    ADD CONSTRAINT "course_tags_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "courses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: course_tags.tagId → tags.id
ALTER TABLE "course_tags"
    ADD CONSTRAINT "course_tags_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "tags"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum: AuditAction — add TAG_* values
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TAG_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TAG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TAG_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TAG_MERGED';

-- AlterEnum: AuditTargetType — add TAG value
ALTER TYPE "AuditTargetType" ADD VALUE IF NOT EXISTS 'TAG';
