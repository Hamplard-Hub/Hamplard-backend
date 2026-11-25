-- Migration: add_composite_indexes (issue #341)
-- Composite indexes for hot multi-column queries. Column order follows the
-- query: equality filters first, then the range / ORDER BY column.
-- quiz_sessions ("status", "expiresAt") already exists and is not recreated.

-- Inbox list, unread count, mark-all-read: WHERE userId = ? AND read = ? ORDER BY createdAt DESC
CREATE INDEX "notifications_userId_read_createdAt_idx" ON "notifications"("userId", "read", "createdAt");

-- Drip re-sync / enrolled-viewer checks: WHERE courseId = ? AND status [IN] ...
CREATE INDEX "enrollments_courseId_status_idx" ON "enrollments"("courseId", "status");

-- Student "my courses": WHERE studentId = ? ORDER BY enrolledAt DESC
CREATE INDEX "enrollments_studentId_enrolledAt_idx" ON "enrollments"("studentId", "enrolledAt");

-- Event replay / reconciliation by ledger range
CREATE INDEX "chain_events_ledger_idx" ON "chain_events"("ledger");

-- Duplicate refund guard: WHERE enrollmentId = ? AND status IN (...)
CREATE INDEX "refunds_enrollmentId_status_idx" ON "refunds"("enrollmentId", "status");

-- Drip notifier: WHERE unlockAt <= now AND notifiedAt IS NULL
CREATE INDEX "enrollment_lesson_unlocks_unlockAt_notifiedAt_idx" ON "enrollment_lesson_unlocks"("unlockAt", "notifiedAt");

-- Coupon redemption history: WHERE couponId = ? ORDER BY redeemedAt DESC
CREATE INDEX "coupon_redemptions_couponId_redeemedAt_idx" ON "coupon_redemptions"("couponId", "redeemedAt");

-- "My invoices": WHERE studentId = ? ORDER BY issuedAt DESC
CREATE INDEX "invoices_studentId_issuedAt_idx" ON "invoices"("studentId", "issuedAt");
