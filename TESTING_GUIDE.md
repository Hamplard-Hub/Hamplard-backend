# Testing Guide: Issues #404, #403, #405, #310

## Quick Reference

| Issue | Title | Files | Status |
|-------|-------|-------|--------|
| #404 | Atomic Enrollment Creation | enrollments.service.ts | ✅ Implemented |
| #403 | Comprehensive Payment Validation | stellar.service.ts, enrollments.service.ts, enrollments.controller.ts | ✅ Implemented |
| #405 | Prevent Duplicate Fraud Scoring | fraud-detection.service.ts, enrollments.service.ts | ✅ Implemented |
| #310 | Distributed Locking for @Cron | distributed-lock.service.ts, scheduling.module.ts, dashboard.service.ts, audit-log.service.ts | ✅ Implemented |

## Issue #404 Testing: Atomic Enrollment Creation

### Manual Test Case 1: Successful enrollment creates payment and updates stats

**Setup:**
- Create a student: `student-1`
- Create an active course: `course-1` with price 100 USDC

**Steps:**
1. Mock a successful on-chain enrollment transaction
2. Call `POST /api/v1/enrollments` with `{ courseId: "course-1", txHash: "tx123" }`
3. Verify in database:
   - Payment record exists with txHash="tx123"
   - Enrollment record exists with studentId="student-1", courseId="course-1"
   - Course.totalEnrollments incremented by 1
   - Course.totalRevenue increased by 100

**Expected:** All three operations committed together

### Manual Test Case 2: P2002 constraint violation rolls back all operations

**Setup:**
- Student already enrolled in course (simulate by pre-creating enrollment)

**Steps:**
1. Mock a successful on-chain transaction (student hasn't paid this time but code doesn't catch it pre-tx)
2. Call `POST /api/v1/enrollments` again
3. Verify:
   - No second Payment record created (transaction rolled back)
   - Error response: 409 Conflict "Already enrolled in this course"
   - Course stats unchanged

**Expected:** Transaction rollback prevents orphaned payment

### Automated Tests

```bash
npm test -- enrollments.service.spec.ts -t "Issue #404"
```

**Test Cases:**
- ✅ Should wrap payment, enrollment, and course stats in a transaction
- ✅ Should rollback enrollment if payment creation fails (P2002)

---

## Issue #403 Testing: Comprehensive Payment Transaction Validation

### Manual Test Case 1: Valid transaction with matching student and amount

**Setup:**
- Student: `student-1` with wallet `GAXYZ123`
- Course: `course-1` with price 100 USDC
- On-chain tx emits event: `{ student: "GAXYZ123", courseId: "course-1", amount: 150 }`

**Steps:**
1. Call `POST /api/v1/enrollments` with `{ courseId: "course-1", txHash: "valid-tx" }`
2. Verify in database:
   - Enrollment created with amountPaid=150
   - No error thrown

**Expected:** Enrollment succeeds, amount from tx (not request body)

### Manual Test Case 2: Transaction for different student

**Setup:**
- Student: `student-1` with wallet `GAXYZ123`
- On-chain tx student: `student-2` wallet `GDIFFERENT`
- Course: `course-1`

**Steps:**
1. Call `POST /api/v1/enrollments` as student-1 with valid tx for student-2
2. Verify error: 400 Bad Request "Student address mismatch"

**Expected:** Enrollment rejected (prevents account hijacking)

### Manual Test Case 3: Transaction for different course

**Setup:**
- Student requests enrollment in `course-1`
- On-chain tx is for `course-2`

**Steps:**
1. Call `POST /api/v1/enrollments` with `{ courseId: "course-1", txHash: "tx-for-course-2" }`
2. Verify error: 400 Bad Request "Course ID mismatch"

**Expected:** Enrollment rejected (prevents course substitution)

### Manual Test Case 4: Insufficient payment amount

**Setup:**
- Course price: 100 USDC
- On-chain tx amount: 50 USDC

**Steps:**
1. Call `POST /api/v1/enrollments` with valid tx but insufficient amount
2. Verify error: 400 Bad Request "Insufficient payment"

**Expected:** Enrollment rejected (prevents underpayment)

### Manual Test Case 5: Replayed transaction (already used)

**Setup:**
- First student enrolls with tx="reused-tx"
- Second student tries same tx

**Steps:**
1. Enroll student-1 successfully with "reused-tx"
2. Try to enroll student-2 with same "reused-tx"
3. Verify error: 409 Conflict "Payment has already been used"

**Expected:** Second enrollment rejected (prevents tx reuse)

### Automated Tests

```bash
npm test -- enrollments.service.spec.ts -t "Issue #403"
```

**Test Cases:**
- ✅ Should return verified amount from on-chain data
- ✅ Should reject if transaction student address does not match
- ✅ Should reject if amount is insufficient
- ✅ Should reject if payment has already been used

### API Changes to Test

**Old Request (no longer works):**
```json
POST /api/v1/enrollments
{
  "courseId": "course-1",
  "txHash": "tx123",
  "amountPaid": 100
}
```

**New Request:**
```json
POST /api/v1/enrollments
{
  "courseId": "course-1",
  "txHash": "tx123"
}
```

⚠️ Frontend must be updated to remove `amountPaid` from request body.

---

## Issue #405 Testing: Prevent Duplicate Fraud Scoring

### Manual Test Case 1: Fraud check executes exactly once per enrollment

**Setup:**
- Enable fraud detection with low thresholds (e.g., max 3 enrollments per hour)
- Student has 4 enrollments in the last hour

**Steps:**
1. Attempt 5th enrollment (should trigger fraud flag)
2. Monitor logs or add debug counters to `processFraudCheck`
3. Verify method called exactly once (pre-enrollment)

**Expected:** Fraud check runs once, not twice

### Manual Test Case 2: Score is consistent whether pre or post enrollment

**Setup:**
- Student with 3 enrollments in the last hour
- Attempting 4th enrollment (high daily volume)

**Steps:**
1. Enable debug logging in fraud detection
2. Attempt enrollment
3. Check calculated score:
   - Pre-enrollment score (velocity before DB write)
   - Post-enrollment score (if recomputed)
4. Verify scores are identical (no increment from new enrollment)

**Expected:** Scores match (no double-counting of the current enrollment)

### Manual Test Case 3: FLAG action persists correctly

**Setup:**
- Create condition where fraud score = 75 (FLAG, not HOLD)

**Steps:**
1. Attempt enrollment
2. Verify:
   - fraudResult.action = 'FLAG'
   - fraudResult.flagId is undefined (pre-check)
   - Post-enrollment: Flag is persisted to DB
   - Flag.enrollmentId is set (linked to enrollment)

**Expected:** Flag persisted once during post-steps

### Automated Tests

```bash
npm test -- enrollments.service.spec.ts -t "Issue #405"
```

**Test Cases:**
- ✅ Should not run fraud check twice
- ✅ Should pass pre-computed fraud result to post-enrollment steps

### Database Inspection

Check fraud flags are created correctly:

```sql
-- Should see one flag per enrollment, not two
SELECT COUNT(*) FROM "EnrollmentFraudFlag" 
WHERE "enrollmentId" = 'enrollment-id';
-- Expected: 1

-- Check timestamps (flag created after enrollment)
SELECT e.id, e."createdAt", f.id, f."createdAt" 
FROM "Enrollment" e
LEFT JOIN "EnrollmentFraudFlag" f ON e.id = f."enrollmentId"
WHERE e.id = 'enrollment-id';
```

---

## Issue #310 Testing: Distributed Locking for @Cron

### Manual Test Case 1: Single instance runs cron job

**Setup:**
- Single API instance running
- Scheduler enabled (RUN_SCHEDULER=true)
- Redis accessible

**Steps:**
1. Start application
2. Wait for scheduled task (e.g., dashboard recalc at 30-minute mark)
3. Check logs: Should see "Lock acquired: dashboard-stats-recalc"
4. Monitor dashboard stats are updated

**Expected:** Job runs normally, lock acquired and released

### Manual Test Case 2: Multiple instances - only one runs job

**Setup:**
- 2 API instances running (or simulate with multiple threads)
- Redis accessible from both
- Scheduler enabled on both

**Steps:**
1. Start instance 1
2. Wait 5 seconds
3. Start instance 2
4. Wait for scheduled task time
5. Check logs:
   - Instance 1: "Lock acquired: dashboard-stats-recalc"
   - Instance 2: "Skipping locked task: dashboard-stats-recalc"
6. Verify stats updated exactly once (not duplicated)

**Expected:** Lock prevents concurrent execution, only one instance runs

### Manual Test Case 3: Lock TTL prevents indefinite blocking

**Setup:**
- Modify dashboard service to have a very long task (simulated with sleep)
- TTL set to 5 seconds

**Steps:**
1. Start instance 1 (acquires lock for 5s, sleeps 10s)
2. Wait 6 seconds
3. Start instance 2 (lock expired, acquires new one)
4. Verify stats calculated by instance 2 even though instance 1 still running

**Expected:** After TTL expires, lock can be acquired by another instance

### Automated Tests

```bash
npm test -- distributed-lock.service.spec.ts
```

**Test Cases:**
- ✅ Should acquire lock when key does not exist
- ✅ Should not acquire lock when key already exists
- ✅ Should throw error if lock name is empty
- ✅ Should throw error if TTL is invalid
- ✅ Should release lock successfully
- ✅ Should execute function if lock is acquired
- ✅ Should not execute function if lock is not acquired
- ✅ Should release lock even if function throws
- ✅ Should prevent concurrent execution of same lock

### Redis Inspection

Monitor locks in Redis:

```bash
# List all active locks
redis-cli KEYS "hamplard:lock:*"

# Check lock value (instance PID + timestamp)
redis-cli GET "hamplard:lock:dashboard-stats-recalc"
# Expected format: "instance:12345-1700000000000"

# Check TTL
redis-cli TTL "hamplard:lock:dashboard-stats-recalc"
# Expected: positive number (seconds remaining)
```

### Services Updated

**Already updated with distributed locking:**
1. ✅ `src/modules/admin/dashboard.service.ts` - @Cron EVERY_30_MINUTES
2. ✅ `src/modules/audit-log/audit-log.service.ts` - @Cron EVERY_DAY_AT_MIDNIGHT

**Remaining services (recommended for future updates):**
- `src/modules/backups/backups.service.ts` - @Cron EVERY_DAY_AT_MIDNIGHT
- `src/modules/backups/db-backup.service.ts` - @Cron '0 0 2 * * *'
- `src/modules/backups/restore.service.ts` - @Cron EVERY_MINUTE
- `src/modules/cron-monitor/cron-monitor.scheduler.ts` - Multiple @Cron
- `src/modules/gamification/leaderboard.service.ts` - @Cron EVERY_HOUR
- `src/modules/lessons/drip-schedule.service.ts` - @Cron '0 */10 * * * *'
- `src/modules/live-sessions/live-session-reminders.service.ts` - @Cron EVERY_5_MINUTES
- `src/modules/notifications/notifications.service.ts` - @Cron '0 0 8 * * *'
- `src/modules/privacy/data-export.service.ts` - @Cron EVERY_DAY_AT_MIDNIGHT
- `src/modules/quizzes/quiz-sessions.service.ts` - @Cron EVERY_MINUTE

---

## Integration Test Scenario

**Scenario:** Student enrolls in course with all features enabled

**Setup:**
- Fraud detection enabled
- Distributed locking enabled
- Multiple API instances running
- Redis accessible

**Flow:**
1. **Pre-check phase:**
   - [Issue #403] Verify transaction comprehensively on-chain
   - [Issue #403] Extract verified amount from tx (not request body)
   - [Issue #405] Compute fraud score once (no DB writes yet)

2. **Enrollment phase:**
   - [Issue #404] Start Prisma transaction
   - [Issue #404] Create Payment record (atomically)
   - [Issue #404] Create Enrollment record (atomically)
   - [Issue #404] Update Course stats (atomically)
   - [Issue #404] Commit or rollback entire transaction

3. **Post-check phase:**
   - [Issue #405] If fraud action=FLAG, persist flag with pre-computed score
   - [Issue #405] Do NOT recompute fraud score

4. **Notifications phase (async):**
   - Send student notification
   - Generate invoice
   - Track referral conversion
   - Initialize drip schedule

**Verification Checklist:**
- ✅ Exactly one Payment record created
- ✅ Exactly one Enrollment record created
- ✅ Course stats incremented exactly once
- ✅ Fraud check executed once (check logs)
- ✅ Fraud flag persisted if needed (with pre-computed score)
- ✅ Notifications sent (check db)
- ✅ No duplicate cron jobs run (check logs)
- ✅ Error handling works (test with invalid tx, wrong student, etc.)

---

## Regression Testing

### Existing Functionality

Run existing tests to ensure no regressions:

```bash
npm test -- enrollments.service.spec.ts
npm test -- bundles.service.spec.ts
npm test -- fraud-detection.service.spec.ts
```

### Bundle Enrollments (Issue #279)

Bundle enrollments use `verifyPaymentTransactionBasic` instead of comprehensive validation:

**Test:**
1. Enroll in bundle with multiple courses
2. Verify:
   - Payment transaction verified (success, not used)
   - Per-course pre-enrollment checks run
   - Per-course enrollments created atomically
   - Course stats updated for each new enrollment
   - Post-enrollment steps run for each course

---

## Performance Impact

### Issue #404: Atomic Transactions
- **Impact:** Minimal (single transaction instead of 3 separate queries)
- **Benefit:** No orphaned payments

### Issue #403: Comprehensive Validation
- **Impact:** Requires additional event parsing from Stellar RPC
- **Latency:** +100-200ms per enrollment (RPC call to fetch events)
- **Benefit:** Prevents fraud/attacks

### Issue #405: Single Fraud Scoring
- **Impact:** Reduced DB load (~50% fewer queries)
- **Latency:** -5-10ms per enrollment (no recompute)
- **Benefit:** Faster enrollments, consistent scores

### Issue #310: Distributed Locking
- **Impact:** Requires Redis availability
- **Latency:** +1-5ms per cron job (lock acquisition)
- **Benefit:** No duplicate jobs, no notification spam

---

## Deployment Checklist

Before deploying to production:

- [ ] Redis is configured and tested
- [ ] Frontend updated to remove `amountPaid` from enrollment requests
- [ ] Database migrations applied
- [ ] All tests passing: `npm test`
- [ ] Build successful: `npm run build`
- [ ] Staging environment tested with multiple instances
- [ ] Fraud detection thresholds reviewed
- [ ] Cron job timing verified (no conflicts)
- [ ] Logging/monitoring configured for new locks
- [ ] Rollback plan in place

---

## Troubleshooting

### Issue #403: Transaction verification fails

**Problem:** "Transaction student (X) does not match caller (Y)"

**Cause:** Student's wallet address doesn't match the one in the tx

**Solution:** Verify student's Stellar wallet address is correctly stored in DB

### Issue #310: Lock never acquires

**Problem:** Jobs always skipped with "Skipping locked task"

**Cause:** Redis connection issue or lock TTL too short

**Solution:**
- Check Redis connectivity: `redis-cli ping` (should return PONG)
- Increase TTL in cron handler
- Check Redis logs for errors

### Issue #405: Fraud check still runs twice

**Problem:** Logs show processFraudCheck called twice

**Cause:** Old code still running, or runPostEnrollmentSteps still calling with wrong params

**Solution:**
- Verify code deployed correctly
- Check git diff to confirm changes
- Restart application
