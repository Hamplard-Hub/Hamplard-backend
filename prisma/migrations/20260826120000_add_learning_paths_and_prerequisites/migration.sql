-- Migration: add_learning_paths_and_prerequisites
-- Created for: Issues #23 — Learning path & curriculum builder API
--              and #24 — Course prerequisites API

-- CreateEnum: LearningPathStatus
CREATE TYPE "LearningPathStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable: learning_paths
CREATE TABLE "learning_paths" (
    "id"           TEXT    NOT NULL,
    "title"        TEXT    NOT NULL,
    "slug"         TEXT    NOT NULL,
    "description"  TEXT,
    "thumbnailUrl" TEXT,
    "status"       "LearningPathStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById"  TEXT    NOT NULL,
    "publishedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable: learning_path_courses  (ordered join table)
CREATE TABLE "learning_path_courses" (
    "id"       TEXT    NOT NULL,
    "pathId"   TEXT    NOT NULL,
    "courseId" TEXT    NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "learning_path_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable: course_prerequisites
CREATE TABLE "course_prerequisites" (
    "id"             TEXT NOT NULL,
    "courseId"       TEXT NOT NULL,
    "prerequisiteId" TEXT NOT NULL,

    CONSTRAINT "course_prerequisites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "learning_paths_slug_key" ON "learning_paths"("slug");
CREATE INDEX "learning_paths_status_idx" ON "learning_paths"("status");
CREATE INDEX "learning_paths_createdById_idx" ON "learning_paths"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "learning_path_courses_pathId_courseId_key" ON "learning_path_courses"("pathId", "courseId");
CREATE UNIQUE INDEX "learning_path_courses_pathId_position_key" ON "learning_path_courses"("pathId", "position");
CREATE INDEX "learning_path_courses_pathId_idx" ON "learning_path_courses"("pathId");
CREATE INDEX "learning_path_courses_courseId_idx" ON "learning_path_courses"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "course_prerequisites_courseId_prerequisiteId_key" ON "course_prerequisites"("courseId", "prerequisiteId");
CREATE INDEX "course_prerequisites_courseId_idx" ON "course_prerequisites"("courseId");
CREATE INDEX "course_prerequisites_prerequisiteId_idx" ON "course_prerequisites"("prerequisiteId");

-- AddForeignKey: learning_paths.createdById → users.id
ALTER TABLE "learning_paths"
    ADD CONSTRAINT "learning_paths_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: learning_path_courses.pathId → learning_paths.id
ALTER TABLE "learning_path_courses"
    ADD CONSTRAINT "learning_path_courses_pathId_fkey"
    FOREIGN KEY ("pathId") REFERENCES "learning_paths"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: learning_path_courses.courseId → courses.id
ALTER TABLE "learning_path_courses"
    ADD CONSTRAINT "learning_path_courses_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "courses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: course_prerequisites.courseId → courses.id
ALTER TABLE "course_prerequisites"
    ADD CONSTRAINT "course_prerequisites_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "courses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: course_prerequisites.prerequisiteId → courses.id
ALTER TABLE "course_prerequisites"
    ADD CONSTRAINT "course_prerequisites_prerequisiteId_fkey"
    FOREIGN KEY ("prerequisiteId") REFERENCES "courses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
