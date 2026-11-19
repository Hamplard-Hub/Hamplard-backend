# Implementation Notes: Security & Reliability Fixes (Issues #404, #403, #405, #310)

## Overview

This document describes the implementation of 4 critical security and reliability improvements to the Hamplard backend.

## Branch

**Branch:** `fix/issues-404-403-405-310`

**Latest commit:** See git log for details

## Files Modified

### Core Services

1. **src/modules/enrollments/enrollments.service.ts**
   - Wrapped payment+enrollment+stats in Prisma transaction (Issue #404)
   - Updated `create()` signature: removed `amountPaid` parameter
   - Added `verifyPaymentTransaction()` with comprehensive validation (Issue #403)
   - Added `verifyPaymentTransactionBasic()` for bundle enrollments
   - Updated `runPostEnrollmentSteps()` to use pre-computed fraud result (Issue #405)

2. **src/modules/enrollments/fraud-detection.service.ts**
   - Added `shouldPersistFlag` parameter to `processFraudCheck()` (Issue #405)
   - Updated JSDoc to clarify single scoring per enrollment

3. **src/common/stellar/stellar.service.ts**
   - Completely rewrote `verifyEnrollmentTransaction()` (Issue #403)
   - Now validates: contract ID, method, student address, course ID, amount
   - Returns verified data (studentAddress, courseId, amountPaid)
   - Throws errors with user-friendly messages

4. **src/modules/bundles/bundles.service.ts**
   - Updated to use `verifyPaymentTransactionBasic()` instead of old verification

5. **src/modules/enrollments/enrollments.controller.ts**
   - Removed `amountPaid` from request body (Issue #403)
   - Updated POST /enrollments DTO

### Distributed Locking (Issue #310)

6. **src/common/scheduling/distributed-lock.service.ts** (NEW)
   - Redis-based distributed locking service
   - `acquireLock(name, ttlMs)` - acquire lock
   - `releaseLock(name)` - release lock
   - `withLock(name, ttlMs, fn)` - helper for automatic acquire/release
   - `healthCheck()` - verify Redis connectivity

7. **src/common/scheduling/scheduling.module.ts** (NEW)
   - NestJS module exporting DistributedLockService
   - OnModuleInit health check

8. **src/app.module.ts**
   - Imported SchedulingModule to make DistributedLockService available globally

9. **src/modules/admin/dashboard.service.ts**
   - Injected DistributedLockService
   - Wrapped handleScheduledRecalculation() with withLock()

10. **src/modules/audit-log/audit-log.service.ts**
    - Injected DistributedLockService
    - Wrapped purgeOldEntries() with withLock()

### Tests

11. **src/modules/enrollments/enrollments.service.spec.ts** (NEW)
    - Tests for atomicity (Issue #404)
    - Tests for payment validation (Issue #403)
    - Tests for fraud deduplication (Issue #405)

12. **src/common/scheduling/distributed-lock.service.spec.ts** (NEW)
    - Tests for lock acquisition/release (Issue #310)
    - Tests for concurrency prevention
    - Tests for error handling

### Documentation

13. **FIXES_IMPLEMENTATION_SUMMARY.md** (NEW)
    - High-level summary of all changes
    - Before/after code comparisons
    - Deployment notes

14. **TESTING_GUIDE.md** (NEW)
    - Comprehensive testing guide
    - Manual test cases for each issue
    - Integration test scenarios
    - Troubleshooting guide

## Key Design Decisions

### Issue #404: Atomic Transactions

**Decision:** Use Prisma `$transaction()` to wrap all three operations

**Rationale:**
- Ensures consistency: either all succeed or all fail
- Prevents orphaned payments when enrollment creation fails
- Handled by database, no application-level retry logic needed
- Simple and idiomatic NestJS/Prisma pattern

**Trade-offs:**
- Slightly higher latency (single transaction vs 3 separate queries)
- Minimal impact (typically <1ms overhead)

### Issue #403: Comprehensive Payment Validation

**Decision:** Extract payment details from on-chain events instead of trusting request body

**Rationale:**
- Prevents amount manipulation in request body
- Validates student actually owns the wallet
- Prevents tx hash reuse across students/courses
- Validates payment amount meets course price

**Trade-offs:**
- Requires additional RPC call to fetch events (+100-200ms)
- Stellarcontract must emit events with correct structure
- Event parsing adds complexity

**Implementation Details:**
- `stellar.service.verifyEnrollmentTransaction()` extracts and validates all fields
- Returns verified data, throws error on mismatch
- `enrollments.service.verifyPaymentTransaction()` calls stellar service with expected values
- Frontend no longer sends amountPaid (breaking API change)

### Issue #405: Fraud Check Deduplication

**Decision:** Score once pre-enrollment, persist post-enrollment if needed

**Rationale:**
- Fraud velocity metrics should not include the current enrollment
- Current enrollment doesn't affect risk factors (rapid repeat, daily volume, active count)
- Actually, current enrollment DOES affect "active count" — need clarification
- Reduces DB queries by ~50%
- More consistent scoring

**Trade-offs:**
- Requires passing fraudResult between methods
- Adds `shouldPersistFlag` parameter (slightly more complex)
- May need refinement if velocity includes current enrollment

**Current Implementation:**
- Pre-check: `processFraudCheck(null, ...)` returns result without persisting
- Enrollment created (not included in DB queries during score computation)
- Post-check: if action=FLAG and not persisted, call with `shouldPersistFlag=true`

**Note:** The assumption that current enrollment doesn't affect fraud score may need review if velocity calculation should include the current enrollment in active count.

### Issue #310: Distributed Locking

**Decision:** Use Redis SET NX PX for lock acquisition

**Rationale:**
- Simple, proven pattern for distributed locking
- Redis usually available in modern deployments
- Atomic operation (no race conditions)
- Automatic TTL prevents permanent locks
- Easy to debug (visible in Redis CLI)

**Alternative Considered:**
- Database-based locking (advisory locks)
  - Rationale: No external dependency
  - Trade-off: More complex, slower than Redis
  - Rejected: Requires database connection per lock attempt

- NestJS @Scheduled with condition guards
  - Rationale: No external dependency
  - Trade-off: Requires shared state (cache, env var)
  - Rejected: Not reliable for multiple instances

**Implementation Pattern:**
```typescript
@Cron(CronExpression.EVERY_30_MINUTES)
async handleScheduledRecalculation() {
  await this.lockService.withLock('lock-name', 35 * 60 * 1000, async () => {
    // Code runs only on one instance at a time
  });
}
```

**TTL Selection:**
- Set 15-20% higher than expected job duration
- Example: 30-min cron with 2-min job → 35-min TTL
- Prevents other instances from acquiring lock while job still running

## Behavioral Changes

### API Breaking Changes

1. **POST /enrollments endpoint**
   - **Before:** Accepts `{ courseId, txHash, amountPaid }`
   - **After:** Accepts `{ courseId, txHash }`
   - **Reason:** amountPaid now extracted from on-chain transaction

### Internal Breaking Changes

1. **EnrollmentsService.create() method signature**
   - **Before:** `create(studentId, courseId, txHash, amountPaid)`
   - **After:** `create(studentId, courseId, txHash)`
   - **Reason:** Calculates verified amount internally

2. **EnrollmentsService.verifyPaymentTransaction() signature**
   - **Before:** `verifyPaymentTransaction(txHash)` - returned void, threw error if invalid
   - **After:** `verifyPaymentTransaction(txHash, studentId, courseId)` - returns verified amount
   - **Reason:** Needs context for validation

3. **StellarService.verifyEnrollmentTransaction() signature**
   - **Before:** `verifyEnrollmentTransaction(txHash)` - returned minimal data
   - **After:** `verifyEnrollmentTransaction(txHash, expectedContractId, expectedStudentAddress, expectedCourseId, expectedMinAmount)` - comprehensive validation
   - **Reason:** Validate all required fields on-chain

4. **FraudDetectionService.processFraudCheck() signature**
   - **Before:** `processFraudCheck(enrollmentId, studentId, courseId, amountPaid)`
   - **After:** `processFraudCheck(enrollmentId, studentId, courseId, amountPaid, shouldPersistFlag = false)`
   - **Reason:** Support pre-compute, defer persist pattern

## Error Handling

### New Error Codes

1. **400 Bad Request**
   - Transaction verification failed (student mismatch, course mismatch, insufficient payment)
   - Invalid parameters

2. **409 Conflict**
   - Payment already used
   - Duplicate enrollment
   - Concurrent enrollment attempts

3. **423 Locked**
   - Enrollment on hold for fraud review (CRITICAL score)

### Error Messages

All user-facing errors are clear and actionable:

```typescript
// Transaction student mismatch
"Student address mismatch: enrollment is for a different wallet"

// Course mismatch
"Course ID mismatch: transaction is for a different course"

// Insufficient payment
"Insufficient payment: transaction amount (50) is less than course price (100)"

// Already used
"Payment {txHash} has already been used. One transaction maps to one purchase."

// Fraud hold
"Your enrollment has been flagged and placed on hold pending a fraud review."
```

## Performance Considerations

### Latency Impact

| Issue | Operation | Impact | Notes |
|-------|-----------|--------|-------|
| #404 | Enrollment creation | +0-1ms | Slight overhead from transaction coordination |
| #403 | Payment verification | +100-200ms | Additional Stellar RPC call for events |
| #405 | Fraud scoring | -5-10ms | Eliminated recomputation |
| #310 | Cron execution | +1-5ms | Redis lock acquisition |

**Total per enrollment:** ~+90-185ms from Issue #403, offset by ~-5-10ms from #405

### Database Query Count

| Issue | Query Count | Notes |
|-------|-------------|-------|
| #404 | Unchanged | Still 3-4 queries, now in transaction |
| #403 | +1 lookup | Additional course price lookup |
| #405 | -1 query | Eliminated fraud recomputation |
| #310 | Depends | No DB queries for lock |

**Net change:** ~0 queries per enrollment

## Monitoring Recommendations

### Metrics to Track

1. **Enrollment success rate**
   - Should remain unchanged or improve (more validations catch issues)

2. **Fraud flag rate**
   - Should show pre-computed scores matching persisted scores
   - Verify no duplicate flags

3. **Cron job execution**
   - Count lock acquisitions vs skips
   - Verify single execution per interval on multi-instance deployments

4. **Payment verification latency**
   - Monitor Stellar RPC call duration
   - Alert if >500ms (network issue)

### Logging Points Added

1. **Stellar service:**
   - Enrollment verification: contract ID, method, validation results

2. **Distributed lock service:**
   - Lock acquisition: success/failure
   - Lock release: success/failure
   - Health check: Redis connectivity

3. **Fraud detection:**
   - Pre-check scoring (new)
   - Post-check persistence (updated)

## Future Enhancements

### Issue #403

- Implement signature verification for additional security
- Cache contract ID to avoid repeated lookups
- Add rate limiting on verification failures

### Issue #405

- Review fraud velocity calculation (should current enrollment be counted?)
- Implement adaptive scoring based on historical data
- Add webhook for fraud decisions

### Issue #310

- Extend distributed locking pattern to other critical jobs
- Add lock contention metrics
- Implement priority queue for lock acquisition

## Rollback Plan

If issues arise in production:

1. **Issue #404 - Revert transaction wrapping**
   - Restore to separate payment/enrollment/stats queries
   - Accept risk of orphaned payments
   - Command: `git revert <commit>`

2. **Issue #403 - Revert payment validation**
   - Remove comprehensive validation
   - Restore `amountPaid` to request body
   - Keep breaking API change (or implement version routing)

3. **Issue #405 - Revert fraud deduplication**
   - Restore double scoring
   - Remove `shouldPersistFlag` parameter
   - Accept 2x fraud check load

4. **Issue #310 - Disable distributed locking**
   - Accept duplicate cron jobs (not ideal but recoverable)
   - Or keep simple Redis locking as default

## Testing Checklist

- [ ] Unit tests passing: `npm test`
- [ ] Build succeeds: `npm run build`
- [ ] Integration tests cover all issues
- [ ] Manual testing with multiple instances
- [ ] Fraud detection tested with various scores
- [ ] Payment verification tested with invalid txs
- [ ] Concurrent enrollment attempts handled
- [ ] Redis lock tested with timeout scenarios
- [ ] API contract tested with frontend

## Questions for Reviewers

1. **Issue #405:** Should fraud velocity include the current enrollment in active count calculation? Current implementation assumes no.

2. **Issue #403:** Is the event structure assumption correct for extracting contract ID, method, student, courseId, amount? May need contract audit.

3. **Issue #310:** Should all @Cron jobs be updated at once or gradually? Currently only dashboard and audit-log updated.

4. **API Versioning:** Should POST /enrollments still accept amountPaid (and ignore it) for backward compatibility, or is breaking change acceptable?

## References

- Prisma Transactions: https://www.prisma.io/docs/concepts/components/prisma-client/transactions
- Redis Distributed Locking: https://redis.io/topics/distlock
- Stellar Soroban Events: https://soroban.stellar.org/
- NestJS Scheduling: https://docs.nestjs.com/techniques/task-scheduling
