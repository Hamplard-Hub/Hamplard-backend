-- Migration: add thumbnailUrl to lessons table
-- Issue: #50 — Video thumbnail auto-generation service

ALTER TABLE "lessons" ADD COLUMN "thumbnailUrl" TEXT;
