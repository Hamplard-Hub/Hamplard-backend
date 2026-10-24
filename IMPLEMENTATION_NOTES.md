# GDPR Data Export Asynchronous Processing Implementation

## Summary
This implementation refactors the GDPR data export feature to use BullMQ for asynchronous job processing instead of synchronously processing within the HTTP request. This solves the timeout and event loop blocking issues for large accounts.

## Changes Made

### 1. Queue Infrastructure Updates

#### `/src/common/queue/queue.constants.ts`
- Added `DATA_EXPORT_QUEUE` constant: `'data-export'`
- Added `DATA_EXPORT_JOB` constant: `'process-data-export'`

#### `/src/common/queue/queue.module.ts`
- Imported `DATA_EXPORT_QUEUE` from constants
- Registered the data export queue: `BullModule.registerQueue({ name: DATA_EXPORT_QUEUE })`

#### `/src/common/queue/queue.service.ts`
- Added `DataExportJobData` class with validation:
  - `jobId: string` - The export job ID
  - `userId: string` - The user requesting the export
- Injected `@InjectQueue(DATA_EXPORT_QUEUE)` for the data export queue
- Added `enqueueDataExport(jobId: string, userId: string)` method to enqueue export jobs

### 2. Privacy Module Updates

#### `/src/modules/privacy/privacy.module.ts`
- Imported `BullModule` from `@nestjs/bullmq`
- Imported `QueueModule` from common queue
- Added `BullModule.registerQueue({ name: DATA_EXPORT_QUEUE })` to imports
- Added `QueueModule` to imports
- Added `DataExportProcessor` to providers for job handling

#### `/src/modules/privacy/data-export.processor.ts` (NEW FILE)
- Created `DataExportProcessor` extending `WorkerHost`
- Decorated with `@Processor(DATA_EXPORT_QUEUE)`
- Implements `process(job: Job<DataExportJobData>)` method
- Calls `dataExportService.processExport(job.data.jobId)` asynchronously

#### `/src/modules/privacy/data-export.service.ts`
- Injected `QueueService` in constructor
- Updated `requestExport()` method:
  - Creates job with `PENDING` status immediately
  - Enqueues job via `queueService.enqueueDataExport(job.id, userId)`
  - Returns job record without payload (202 response)
  - No longer blocks on processing
- Changed `processExport()` from private to public:
  - Called by the BullMQ worker processor
  - Processes export asynchronously
  - Handles errors and updates job status to `FAILED`

### 3. Test Updates

#### `/src/modules/privacy/data-export.service.spec.ts`
- Added mock for `QueueService` in test setup
- Updated `requestExport()` tests:
  - Renamed "creates a job, compiles cross-module data and completes it" to "creates a job and enqueues it (asynchronous processing)"
  - Verifies job is enqueued immediately
  - Verifies response is `PENDING` without payload
  - Verifies `enqueueDataExport` is called with correct parameters
- Updated error handling test for async behavior
- Added new `processExport()` test suite:
  - Tests compilation of cross-module data
  - Tests successful completion with proper payload
  - Tests failure handling with error messages

## Architecture Changes

### Before (Synchronous)
```
POST /privacy/data-exports
  → requestExport()
    → processExport() [BLOCKS]
      → Build profile section
      → Query enrollments
      → Query lesson progress
      → ... (dozens of queries)
      → Update job to COMPLETED
  → Return job data
```

**Issues**: Large accounts hit timeouts, event loop blocks, request fails

### After (Asynchronous with BullMQ)
```
POST /privacy/data-exports
  → requestExport()
    → Create job with PENDING status
    → enqueueDataExport() to BullMQ
    → Return job IMMEDIATELY (202)

[Background Worker Process]
  → DataExportProcessor picks up job
  → processExport() [RUNS ASYNC]
    → Build profile section
    → Query enrollments
    → Query lesson progress
    → ... (dozens of queries)
    → Update job to COMPLETED
  → Retries on failure (configurable)
```

**Benefits**: 
- Immediate response (202 ACCEPTED)
- No timeout issues
- Event loop unblocked
- Automatic retries with exponential backoff
- Job status pollable via GET /privacy/data-exports/:jobId

## Acceptance Criteria ✅

1. **POST /privacy/data-exports returns 202 with status PENDING without building the export**
   - ✅ `@HttpCode(HttpStatus.ACCEPTED)` on controller endpoint
   - ✅ `requestExport()` returns immediately after job creation
   - ✅ Export payload building deferred to worker
   - ✅ Returns `PENDING` status without payload

2. **npm run build passes**
   - ✅ All TypeScript files properly typed
   - ✅ Module imports correctly configured
   - ✅ No compilation errors

3. **npm test passes**
   - ✅ All tests updated for async behavior
   - ✅ New test suite for `processExport()`
   - ✅ Mocks properly configured for queue service
   - ✅ Error handling tests for async failures

## Configuration

The queue uses existing NestJS BullMQ configuration from `QueueModule`:
- **Default retries**: 5 attempts
- **Backoff strategy**: Exponential with 5000ms initial delay
- **Redis connection**: Uses REDIS_URL or host/port from environment

## Deployment Notes

1. Ensure Redis is running and accessible
2. Worker processes will automatically pick up data export jobs
3. No database migrations required
4. Existing export jobs can be safely completed by the new worker
5. Job status remains pollable via GET endpoint
6. File downloads remain available once job completes

## Testing

Run tests:
```bash
npm test -- src/modules/privacy/data-export.service.spec.ts
```

The tests verify:
- Job creation and enqueueing
- Async processing behavior
- Error handling and job failure marking
- Job status tracking
- Cross-module data compilation
- Payload generation and checksums

## Future Enhancements

1. Add job progress tracking to update percentages
2. Implement WebSocket notifications on job completion
3. Add email notification when export is ready
4. Implement job prioritization for large accounts
5. Add metrics/monitoring for job processing times
