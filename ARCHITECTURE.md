# Hamplard Backend Architecture

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Layers](#architecture-layers)
3. [On-Chain / Off-Chain Data Flow](#on-chain--off-chain-data-flow)
4. [Core Components](#core-components)
5. [Data Models](#data-models)
6. [Integration Patterns](#integration-patterns)
7. [Security & Verification](#security--verification)

---

## System Overview

Hamplard is a hybrid decentralized learning platform built on **NestJS** with **Stellar blockchain** integration. The architecture follows a **separation of concerns** pattern where:

- **Off-chain (Backend)**: Manages course content, user progress, assignments, and media
- **On-chain (Soroban Smart Contract)**: Handles payments, enrollments, and certificate verification

### Technology Stack

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Layer                            │
│  Next.js Frontend + Freighter Wallet (User Signatures)      │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   NestJS Backend (This Repo)                 │
│  ┌────────────┬──────────────┬─────────────┬──────────────┐ │
│  │   REST API │ BullMQ Jobs  │ Events Poll │ File Uploads │ │
│  └────────────┴──────────────┴─────────────┴──────────────┘ │
└─────────────────────────────────────────────────────────────┘
            ▼                                    ▼
┌──────────────────────┐           ┌───────────────────────────┐
│   PostgreSQL + Redis │           │  Stellar Network          │
│   (Off-chain State)  │           │  Soroban Smart Contract   │
│                      │           │  (On-chain State)         │
└──────────────────────┘           └───────────────────────────┘
```

**Core Dependencies:**
- **Framework**: NestJS 10.x
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache**: Redis (via ioredis)
- **Queue**: BullMQ
- **Blockchain**: Stellar SDK (@stellar/stellar-sdk v12.x)
- **Storage**: AWS S3 / Local filesystem
- **Search**: MeiliSearch
- **Notifications**: Nodemailer, Africa's Talking SMS

---

## Architecture Layers

### 1. Presentation Layer (Controllers)

```typescript
// REST API Controllers
src/modules/*/
  ├── *.controller.ts       // HTTP endpoints
  ├── dto/                  // Request/response DTOs
  └── *.module.ts          // Dependency injection
```

**Key Controllers:**
- `AuthController`: Sign-In With Stellar (nonce-based JWT)
- `CoursesController`: CRUD + approval workflow
- `EnrollmentsController`: Registration & progress tracking
- `CertificatesController`: Issuance & verification
- `EventsController`: Blockchain event monitoring

### 2. Business Logic Layer (Services)

```typescript
src/modules/*/
  └── *.service.ts         // Business rules & orchestration
```

**Core Services:**
- `EnrollmentsService`: Enrollment validation & payment verification
- `CertificatesService`: Certificate generation & on-chain verification
- `EventsService`: Blockchain event polling & processing
- `StellarService`: RPC communication & transaction verification
- `NotificationsService`: Multi-channel notifications

### 3. Data Access Layer

```typescript
src/common/prisma/
  └── prisma.service.ts    // Database connection pool
```

**Prisma Schema** (`prisma/schema.prisma`):
- 50+ models covering courses, enrollments, certificates, etc.
- Complex relationships with cascading deletes
- Full-text search integration with MeiliSearch

### 4. Infrastructure Layer

```typescript
src/common/
  ├── stellar/             // Blockchain integration
  ├── filters/             // Global exception handling
  ├── guards/              // JWT + role-based auth
  └── interceptors/        // Response transformation
```

---

## On-Chain / Off-Chain Data Flow

### Design Philosophy

The backend follows a **hybrid architecture** where:

1. **Financial transactions** (payments, enrollments, certificates) are anchored on-chain for **immutability**
2. **Content and progress** are stored off-chain for **performance and scalability**
3. The backend acts as the **source of truth** for derived state (progress, assignments)
4. The blockchain acts as the **audit trail** for critical events

### Responsibility Matrix

| Data Type | Backend (Off-Chain) | Contract (On-Chain) | Synced Via |
|-----------|---------------------|---------------------|------------|
| **User Profiles** | ✅ Primary | ❌ | Stellar Address |
| **Course Content** | ✅ Primary (videos, text) | ❌ | - |
| **Course Metadata** | ✅ Primary (title, description) | ✅ Registered | `course_registered` event |
| **Course Approval** | ✅ DRAFT→PENDING→ACTIVE | ✅ `approve_course()` | `course_approved` event |
| **Payment Transactions** | ✅ Verified from chain | ✅ Primary (USDC transfers) | Transaction verification |
| **Enrollments** | ✅ Primary (progress tracking) | ✅ Proof of purchase | `student_enrolled` event |
| **Lesson Progress** | ✅ Primary (100% off-chain) | ❌ | - |
| **Assignments** | ✅ Primary (upload & review) | ❌ | - |
| **Certificates** | ✅ DB record + PDF | ✅ Immutable proof | `certificate_issued` event |
| **Certificate Verification** | ✅ Cross-checks on-chain | ✅ Primary (validity) | RPC simulation |

---

## Core Data Flows

### Flow 1: Course Creation & Approval

```
┌──────────────────────────────────────────────────────────────────┐
│                    1. COURSE CREATION (Off-Chain)                 │
└──────────────────────────────────────────────────────────────────┘

Instructor → POST /courses
  ↓
Backend creates Course (status: DRAFT)
  ↓
Instructor adds lessons/modules
  ↓
Instructor → POST /courses/:id/submit → Status: PENDING
  ↓
Admin → GET /courses/admin/pending
  ↓
Admin → POST /courses/:id/approve

┌──────────────────────────────────────────────────────────────────┐
│                   2. ON-CHAIN REGISTRATION                        │
└──────────────────────────────────────────────────────────────────┘

Instructor wallet → approve_course(courseId) via Freighter
  ↓
Contract emits: course_approved(courseId)
  ↓
EventsService polls RPC every 5s
  ↓
Detects event → handleCourseApproved(payload)
  ↓
Backend updates: Status → ACTIVE
  ↓
Course indexed in MeiliSearch
  ↓
Instructor notified: "Course is now live!"
```

**Key Files:**
- `src/modules/courses/courses.service.ts` (approval logic)
- `src/modules/events/events.service.ts` (event polling)
- `src/common/stellar/stellar.service.ts` (RPC client)

---

### Flow 2: Student Enrollment (Critical Path)

```
┌──────────────────────────────────────────────────────────────────┐
│              1. PAYMENT TRANSACTION (On-Chain First)              │
└──────────────────────────────────────────────────────────────────┘

Student wallet → enroll(courseId, amount) via Freighter
  ↓
Soroban contract:
  - Verifies USDC payment
  - Splits revenue (80% instructor, 20% platform)
  - Records enrollment
  - Emits: student_enrolled(courseId, studentAddress, amount)
  ↓
Transaction succeeds → returns txHash

┌──────────────────────────────────────────────────────────────────┐
│          2. BACKEND REGISTRATION (Off-Chain Verification)         │
└──────────────────────────────────────────────────────────────────┘

Frontend → POST /enrollments { courseId, txHash }
  ↓
EnrollmentsService.create():
  ├─ 1. Verify course is ACTIVE (not DRAFT/PAUSED)
  ├─ 2. Verify txHash on-chain (comprehensive):
  │     ├─ Transaction succeeded
  │     ├─ Called enroll() method
  │     ├─ Student address matches JWT user
  │     ├─ Course ID matches request
  │     ├─ Amount >= course price
  │     └─ txHash not already used (1 tx = 1 enrollment)
  ├─ 3. Check prerequisites (all required courses completed)
  ├─ 4. Run fraud detection (scoring: LOW/MEDIUM/HIGH/CRITICAL)
  └─ 5. Atomic transaction:
        ├─ Create Payment record (txHash uniqueness)
        ├─ Create Enrollment record
        └─ Increment Course.totalEnrollments & totalRevenue

Post-enrollment:
  ├─ Generate Invoice PDF
  ├─ Track referral conversion (issue referrer rewards)
  ├─ Initialize drip schedule (if enabled)
  ├─ Notify student: "Enrollment confirmed!"
  └─ Notify instructor: "New student enrolled"

┌──────────────────────────────────────────────────────────────────┐
│           3. EVENT RECONCILIATION (Background Sync)               │
└──────────────────────────────────────────────────────────────────┘

EventsService polls every 5s:
  ↓
Detects: student_enrolled(courseId, studentAddress, amount)
  ↓
handleStudentEnrolled():
  ├─ Find student by stellarAddress
  ├─ Check if enrollment exists in DB
  ├─ If YES → Skip (already registered via API)
  └─ If NO → Log warning (awaiting API registration)

NOTE: Stats are ONLY updated by POST /enrollments, never by events.
This prevents double-counting when the same event is replayed.
```

**Key Files:**
- `src/modules/enrollments/enrollments.service.ts` (verification & registration)
- `src/common/stellar/stellar.service.ts::verifyEnrollmentTransaction()` (on-chain verification)
- `src/modules/events/events.service.ts::handleStudentEnrolled()` (reconciliation)

**Critical Features:**
- **Issue #403**: Comprehensive transaction verification (not just status check)
- **Issue #240**: One payment = one enrollment (via unique txHash)
- **Issue #404**: Atomic payment + enrollment + stats update
- **Issue #405**: Pre-enrollment fraud checks (not post-facto)

---

### Flow 3: Progress Tracking & Completion

```
┌──────────────────────────────────────────────────────────────────┐
│                   100% OFF-CHAIN (Performance)                    │
└──────────────────────────────────────────────────────────────────┘

Student watches lesson:
  Frontend → PATCH /lessons/:id/progress { watchedSecs }
  ↓
Backend updates LessonProgress.watchedSecs

Student completes lesson:
  Frontend → POST /lessons/:id/complete
  ↓
Backend:
  ├─ Set LessonProgress.completed = true
  ├─ Recalculate Enrollment.progressPercent
  └─ Check if all lessons completed (100%)

If Enrollment reaches 100%:
  ├─ Set Enrollment.status = COMPLETED
  ├─ Set Enrollment.completedAt = now()
  ├─ Notify student: "Course completed! 🎉"
  └─ Ready for certificate issuance

NOTE: Progress is NEVER written to blockchain (too expensive).
The contract only records enrollment and certificates.
```

**Key Files:**
- `src/modules/lessons/lessons.service.ts` (progress updates)
- `src/modules/enrollments/enrollments.service.ts` (completion detection)

---

### Flow 4: Certificate Issuance (Two-Phase Commit)

```
┌──────────────────────────────────────────────────────────────────┐
│                   1. BACKEND PREPARATION (Off-Chain)              │
└──────────────────────────────────────────────────────────────────┘

Admin → POST /certificates { studentId, courseId }
  ↓
CertificatesService.issue():
  ├─ Verify Enrollment.status = COMPLETED (100% progress)
  ├─ Verify student passed certification exam (if exists)
  ├─ Check no certificate already exists
  ├─ Generate certificate ID: CERT-{UUID-12-chars}
  ├─ Create Certificate record in DB (txHash = null)
  ├─ Render PDF using course category template
  ├─ Store PDF in S3/filesystem
  └─ Notify student: "Certificate issued!"

Certificate state: PENDING (waiting for on-chain anchor)

┌──────────────────────────────────────────────────────────────────┐
│                 2. BLOCKCHAIN ANCHORING (On-Chain)                │
└──────────────────────────────────────────────────────────────────┘

Admin wallet → issue_certificate(certificateId, studentAddress, courseId)
  ↓
Contract:
  ├─ Verifies course is completed
  ├─ Records certificate immutably
  └─ Emits: certificate_issued(certificateId, studentAddress, courseId)
  ↓
Transaction returns txHash

┌──────────────────────────────────────────────────────────────────┐
│                   3. TXHASH UPDATE (Off-Chain)                    │
└──────────────────────────────────────────────────────────────────┘

Admin → PATCH /certificates/:id/tx-hash { txHash }
  ↓
Backend updates Certificate.txHash = txHash

Certificate state: VALID (anchored on-chain)

┌──────────────────────────────────────────────────────────────────┐
│                 4. EVENT CONFIRMATION (Background)                │
└──────────────────────────────────────────────────────────────────┘

EventsService polls:
  ↓
Detects: certificate_issued(certificateId, studentAddress, courseId)
  ↓
handleCertificateIssued():
  └─ Notify student: "🎓 Certificate is on-chain!"
```

**Key Files:**
- `src/modules/certificates/certificates.service.ts` (issuance logic)
- `src/modules/certificates/certificate-pdf.service.ts` (PDF generation)
- `src/modules/events/events.service.ts::handleCertificateIssued()`

---

### Flow 5: Certificate Verification (Public Endpoint)

```
┌──────────────────────────────────────────────────────────────────┐
│          PUBLIC VERIFICATION (No Authentication Required)         │
└──────────────────────────────────────────────────────────────────┘

Anyone → GET /certificates/verify/:id
  ↓
CertificatesService.verify():
  ├─ 1. Query DB for certificate
  │     └─ If not found → return 404
  ├─ 2. Check DB revocation flag
  │     └─ If isRevoked = true → return "INVALID (revoked)"
  ├─ 3. Check if on-chain txHash exists
  │     └─ If txHash = null → return "PENDING (not issued on-chain yet)"
  └─ 4. Cross-check on-chain state:
        ├─ Call StellarService.verifyCertificateOnChain(certificateId)
        ├─ Simulate verify_certificate(certificateId) via RPC
        └─ Results:
            ├─ RPC error → return "UNVERIFIABLE (network issue)"
            ├─ Contract returns false → return "INVALID (not found on-chain)"
            └─ Contract returns true → return "VALID" + certificate data

Response states:
  - VALID: Certificate exists in DB and on-chain, not revoked
  - INVALID: Revoked or not found on-chain
  - PENDING: Issued in DB but not yet anchored on-chain
  - UNVERIFIABLE: RPC failure (network issue, not fraud)
```

**Key Files:**
- `src/modules/certificates/certificates.service.ts::verify()` (tri-state verification)
- `src/common/stellar/stellar.service.ts::verifyCertificateOnChain()` (RPC simulation)

**Security Notes:**
- **Issue #246**: Public endpoints exclude admin PII (revokedBy user details)
- **Issue #247**: Differentiates RPC errors from actual invalidity
- Verification is **read-only** (no gas fees, no wallet required)

---

## Core Components

### 1. Stellar Integration (`StellarService`)

**Location**: `src/common/stellar/stellar.service.ts`

**Responsibilities:**
- RPC client management (connects to Stellar Testnet/Mainnet)
- Contract event fetching (paginated, cursor-based)
- Read-only contract simulations (no signing)
- Transaction verification (comprehensive validation)
- USDC stroops ↔ human-readable conversions

**Key Methods:**

```typescript
// RPC Access
getClient(): SorobanRpc.Server
getLatestLedger(): Promise<number>
fetchContractEvents(startLedger, cursor?): Promise<EventsResponse>

// Read-Only Contract Calls (Simulation)
simulateCall(method: string, args: xdr.ScVal[]): Promise<any>
isEnrolledOnChain(studentAddress, courseId): Promise<boolean>
verifyCertificateOnChain(certificateId): Promise<{ valid: boolean }>

// Transaction Verification (Issue #403)
getTransactionStatus(txHash): Promise<{ status, successful } | null>
verifyEnrollmentTransaction(txHash, contractId, studentAddress, courseId, minAmount)
  → Returns: { studentAddress, courseId, amountPaid }
  → Validates: success, method=enroll, address match, course match, amount >= price

// Utilities
stroopsToUsdc(stroops: string | bigint): string  // 10_000_000 → "1.00"
usdcToStroops(usdc: string | number): bigint     // "1.00" → 10_000_000n
```

**Configuration** (`.env`):
```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=testnet
HAMPLARD_CONTRACT_ID=CA...
```

**No Write Operations:**
- The backend NEVER signs transactions
- All writes (enroll, approve_course, issue_certificate) are signed by **user wallets** (Freighter)
- Admin operations use a separate **secure signing service** (not in this repo)

---

### 2. Event Polling System (`EventsService`)

**Location**: `src/modules/events/events.service.ts`

**Architecture**: Durable, crash-resilient event poller with exponential backoff retry.

**Polling Mechanism:**

```typescript
// Configurable interval (default: 5 seconds)
EVENT_POLLING_INTERVAL_MS=5000

// Checkpoint persistence (crash recovery)
EventPollerCheckpoint {
  key: "stellar-event-poller"
  lastProcessedLedger: number       // Resume point
  lastProcessedCursor: string?      // Mid-page resume token
  lastPolledAt: DateTime
  consecutiveWriteFailures: number  // Health monitoring
}
```

**Event Processing Flow:**

```typescript
1. Load checkpoint from DB (or start from latest - 10 ledgers)
2. Poll RPC: fetchContractEvents(lastProcessedLedger, cursor?)
3. For each event in page:
   a. Save raw event to ChainEvent table (dedupe via unique eventId)
   b. If new event (not duplicate):
      - Run handler (handleCourseApproved, handleStudentEnrolled, etc.)
      - Mark processed = true (or log error for retry)
   c. Advance checkpoint cursor to event.pagingToken
   d. Persist checkpoint (crash recovery)
4. If page < 100 events: advance to next ledger, clear cursor
5. Repeat on next tick (5s later)
```

**Event Handlers:**

| Event Name | Handler | Backend Action |
|-----------|---------|----------------|
| `course_registered` | `handleCourseRegistered` | Log only (backend already has record) |
| `course_approved` | `handleCourseApproved` | Update status → ACTIVE, index in search |
| `course_paused` | `handleCoursePaused` | Update status → PAUSED |
| `course_archived` | `handleCourseArchived` | Update status → ARCHIVED |
| `student_enrolled` | `handleStudentEnrolled` | Reconcile (skip if already registered) |
| `course_completed` | `handleCourseCompleted` | Update enrollment status, notify student |
| `certificate_issued` | `handleCertificateIssued` | Notify student "🎓 On-chain!" |
| `certificate_revoked` | `handleCertificateRevoked` | Update isRevoked flag |

**Error Handling:**

```typescript
// Retry with exponential backoff
MAX_HANDLER_ATTEMPTS = 5
RETRY_BASE_DELAY_MS = 5_000      // 5s
RETRY_MAX_DELAY_MS = 300_000     // 5min

// Dead-letter queue for failed events
GET /events/dead-letter              // List events that exceeded max attempts
POST /events/dead-letter/:id/retry   // Manual admin retry
```

**Issue #228 - Recovery:**
- If RPC returns "start ledger out of range" → Jump to latest - 10 ledgers
- If empty poll → Advance to latestLedger + 1 (don't get stuck)
- If checkpoint ledger > chain tip → Cold start near tip

**Issue #229 - Re-entrancy Guard:**
```typescript
private isPolling = false;

async pollEvents() {
  if (this.isPolling) {
    this.logger.debug('Previous poll still running; skipping');
    return;
  }
  this.isPolling = true;
  try {
    // ... polling logic
  } finally {
    this.isPolling = false;
  }
}
```

**Health Monitoring:**
```bash
GET /health/checkpoint
{
  "lastProcessedLedger": 12345,
  "lastProcessedCursor": "0-12345-1",
  "lastPolledAt": "2026-11-24T10:30:00Z",
  "resumedFromCheckpoint": true,
  "consecutiveWriteFailures": 0,
  "healthy": true
}
```

---

### 3. Payment Verification (`EnrollmentsService`)

**Location**: `src/modules/enrollments/enrollments.service.ts`

**Critical Features (Issues #239, #240, #403, #404, #405):**

```typescript
async create(studentId, courseId, txHash) {
  // PRE-CHECK #0: Course must be ACTIVE
  const course = await findCourse(courseId);
  assertCourseActive(course);  // Reject DRAFT/PAUSED

  // PRE-CHECK #0B: Comprehensive on-chain verification
  const verifiedAmount = await verifyPaymentTransaction(
    txHash, studentId, courseId
  );
  // ↑ Validates: success, method=enroll, address, course, amount
  // ↑ Returns amount from on-chain data (not request body)
  // ↑ Throws if txHash already used (issue #240)

  // PRE-CHECK #1: No duplicate enrollment
  const existing = await findEnrollment(studentId, courseId);
  if (existing) throw ConflictException;

  // PRE-CHECK #2: Prerequisites met (issue #24)
  await checkPrerequisites(studentId, courseId);
  // ↑ Throws 403 with missing course list

  // PRE-CHECK #3: Fraud scoring (issue #405)
  const fraudResult = await fraudDetection.processFraudCheck(
    null, studentId, courseId, verifiedAmount
  );
  if (fraudResult.action === 'HOLD') {
    throw HttpException(423, 'Enrollment Locked');
  }

  // ATOMIC TRANSACTION (issue #404)
  const enrollment = await prisma.$transaction(async (tx) => {
    // 1. Create Payment record (enforces txHash uniqueness)
    await tx.payment.create({
      data: { txHash, studentId, amountPaid: verifiedAmount }
    });

    // 2. Create Enrollment
    const enrollment = await tx.enrollment.create({
      data: {
        studentId, courseId, txHash,
        amountPaid: verifiedAmount,
        platformFeePercent: course.platformFeePercent  // Snapshot
      }
    });

    // 3. Update Course stats
    await tx.course.update({
      where: { id: courseId },
      data: {
        totalEnrollments: { increment: 1 },
        totalRevenue: { increment: verifiedAmount }
      }
    });

    return enrollment;
  });

  // POST-ENROLLMENT SIDE EFFECTS
  await runPostEnrollmentSteps(enrollment, fraudResult, txHash, verifiedAmount);
  // ↑ Invoice, referral rewards, drip schedule, notifications

  return enrollment;
}
```

**Fraud Detection (Issue #405):**

```typescript
// Scoring factors:
- Payment velocity (enrollments in last 24h)
- Payment amount anomalies (stddev from course average)
- Multiple courses from same IP
- Unusual enrollment patterns

// Risk levels:
LOW (0-39):      No action
MEDIUM (40-69):  Log only
HIGH (70-89):    FLAG (proceed, manual review later)
CRITICAL (90+):  HOLD (block enrollment immediately)
```

---

### 4. Database Schema (Prisma)

**Key Models:**

```prisma
// User Management
User {
  id: String (UUID)
  stellarAddress: String? (unique)
  googleId: String? (unique for OAuth)
  role: UserRole (STUDENT | INSTRUCTOR | ADMIN)
  twoFactorEnabled: Boolean
  isBanned: Boolean
  isSuspended: Boolean
  ...
}

// Course Lifecycle
Course {
  id: String (matches on-chain course_id)
  instructorAddress: String (Stellar address)
  status: CourseStatus (DRAFT | PENDING | ACTIVE | PAUSED | ARCHIVED)
  price: Decimal (USDC)
  platformFeePercent: Int (default: 20%)
  totalEnrollments: Int
  totalRevenue: Decimal
  txHash: String? (on-chain registration tx)
  ...
}

// Payment Tracking (Issue #240)
Payment {
  id: String (UUID)
  txHash: String (unique!) // One tx = one payment
  studentId: String
  amountPaid: Decimal (verified from on-chain)
  paymentType: String (ENROLLMENT | BUNDLE | REFUND)
  verifiedAt: DateTime
}

// Enrollment State
Enrollment {
  id: String (UUID)
  studentId: String
  courseId: String
  amountPaid: Decimal
  platformFeePercent: Int (snapshot at enrollment time)
  txHash: String? (references Payment)
  status: EnrollmentStatus (ACTIVE | COMPLETED | REFUNDED)
  progressPercent: Int (0-100, calculated from lessons)
  completedAt: DateTime?
  
  @@unique([studentId, courseId])  // One enrollment per student per course
}

// Progress Tracking (100% Off-Chain)
LessonProgress {
  id: String (UUID)
  enrollmentId: String
  lessonId: String
  completed: Boolean
  watchedSecs: Int (video position)
  completedAt: DateTime?
  
  @@unique([enrollmentId, lessonId])
}

// Certificate Anchoring
Certificate {
  id: String (CERT-{12-char-UUID})
  studentId: String
  courseId: String
  courseTitle: String (snapshot)
  instructorAddress: String
  txHash: String? (on-chain issuance tx)
  pdfUrl: String? (S3/filesystem path)
  isRevoked: Boolean
  revokedById: String?
  revokedAt: DateTime?
  issuedAt: DateTime
  
  @@unique([studentId, courseId])
}

// Event Polling
ChainEvent {
  id: String (UUID)
  eventName: String (course_approved, student_enrolled, etc.)
  ledger: Int
  txHash: String
  eventIndex: Int
  eventId: String (unique!) // Deduplication key
  payload: Json
  processed: Boolean
  processedAt: DateTime?
  handlerError: String?
  attemptCount: Int
  retryAt: DateTime?
  
  @@unique([txHash, eventIndex])
  @@unique([eventId])
}

// Checkpoint for Crash Recovery
EventPollerCheckpoint {
  id: String (UUID)
  key: String (unique = "stellar-event-poller")
  lastProcessedLedger: Int
  lastProcessedCursor: String?
  lastPolledAt: DateTime?
  consecutiveWriteFailures: Int
  lastWriteError: String?
}
```

---

## Integration Patterns

### 1. Authentication Flow (Sign-In With Stellar)

```
Client:
  1. Request nonce: GET /auth/nonce?address=G...
  2. Backend generates random nonce, stores in cache (5min TTL)
  3. User signs nonce with Freighter wallet
  4. Submit: POST /auth/login { address, signature }
  5. Backend verifies signature against cached nonce
  6. If valid:
     - Create/update User record
     - Generate JWT (24h expiry) with { userId, stellarAddress, role }
     - Return { accessToken, refreshToken, user }

Subsequent requests:
  Authorization: Bearer {JWT}
```

**Security:**
- Nonces expire in 5 minutes (Redis TTL)
- JWT includes `jti` claim tracked in `Session` table (revocable per-device)
- Refresh tokens use rotation strategy (family invalidation)

---

### 2. File Upload Strategy

**Supported Categories:**
```typescript
/uploads/thumbnail   → 5 MB, images only
/uploads/video       → 500 MB, video formats
/uploads/resource    → 50 MB, documents (PDF, ZIP)
/uploads/assignment  → 100 MB, student submissions
```

**Storage Backends:**
1. **AWS S3** (production):
   ```env
   AWS_S3_BUCKET=hamplard-uploads
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   ```

2. **Local Filesystem** (development):
   ```env
   UPLOAD_MODE=local
   LOCAL_UPLOAD_PATH=./uploads
   ```

**Security:**
- ClamAV virus scanning (optional, configurable)
- MIME type validation
- Filename sanitization
- Signed URLs for private content (S3 presigned URLs)

---

### 3. Notification System

**Channels:**
1. **In-App** (`Notification` table): Always created
2. **Email** (Nodemailer): Configurable per notification type
3. **Push** (FCM via device tokens): Mobile apps
4. **SMS** (Africa's Talking): Critical alerts (OTP, payment confirmations)

**Digest Mode:**
- Daily email summaries (opt-in)
- Background job aggregates unread notifications
- Sent at user's preferred time (default: 9am UTC)

**Preferences:**
```typescript
NotificationPreference {
  userId: String
  type: NotificationType (COURSE_APPROVED, ENROLLMENT_CONFIRMED, etc.)
  email: Boolean
  push: Boolean
  inApp: Boolean
}
```

---

### 4. Search Integration (MeiliSearch)

**Indexed Models:**
- `Course` (title, description, category, instructor name)
- `User` (name, email, stellarAddress - admin search only)

**Index Triggers:**
- Course approved → Index course + instructor
- Course updated → Reindex course
- Course archived → Remove from index

**Search Endpoint:**
```bash
GET /courses?search=tailoring&category=fashion&level=beginner
```

---

## Security & Verification

### 1. Transaction Verification (Issue #403)

**Problem**: Malicious users could submit invalid txHash values.

**Solution**: Comprehensive on-chain verification:

```typescript
async verifyEnrollmentTransaction(txHash, contractId, studentAddress, courseId, minAmount) {
  // 1. Fetch transaction from RPC
  const tx = await rpc.getTransaction(txHash);
  if (tx.status !== 'SUCCESS') throw new Error('Transaction failed');

  // 2. Fetch contract events from that transaction
  const events = await rpc.getEvents({ startLedger: tx.ledger, ... });

  // 3. Find the enroll event
  const enrollEvent = events.find(e => 
    e.contractId === contractId &&
    e.method === 'enroll'
  );
  if (!enrollEvent) throw new Error('No enroll event found');

  // 4. Parse event payload
  const { student, courseId: txCourseId, amount } = parseEvent(enrollEvent);

  // 5. Validate against request
  if (student !== studentAddress) throw new Error('Student address mismatch');
  if (txCourseId !== courseId) throw new Error('Course ID mismatch');
  if (amount < minAmount) throw new Error('Insufficient payment');

  return { studentAddress, courseId, amountPaid: amount };
}
```

**Prevents:**
- Reusing someone else's txHash
- Submitting a txHash for a different course
- Claiming enrollment without payment
- Double-spending a single txHash

---

### 2. Fraud Detection (Issue #405)

**Scoring Algorithm:**

```typescript
Score = 0
if (enrollments_last_24h > 10) Score += 30
if (amount_stddev > 2) Score += 20
if (ip_enrollments_today > 5) Score += 25
if (new_account_hours < 1) Score += 15
if (velocity_suspicious) Score += 20

if (Score >= 90) → HOLD (block enrollment)
if (Score >= 70) → FLAG (proceed, manual review)
if (Score >= 40) → LOG (monitor)
if (Score < 40)  → ALLOW (no action)
```

**Admin Review:**
```bash
GET /enrollments/fraud-queue             # List flagged enrollments
POST /enrollments/fraud/:flagId/clear    # Approve after review
POST /enrollments/fraud/:flagId/void     # Confirm fraud, void enrollment
```

---

### 3. Rate Limiting

**Global Rate Limits:**
```typescript
@ThrottlerGuard()
{
  ttl: 60,      // 60 seconds
  limit: 100    // 100 requests per minute
}
```

**Auth Endpoints (Stricter):**
```typescript
/auth/login  → 5 requests / 15 minutes (prevent brute force)
/auth/nonce  → 10 requests / minute
```

**Health Check (Exempt):**
```typescript
/health      → No rate limit (monitoring)
```

---

### 4. Role-Based Access Control

**Roles:**
```typescript
enum UserRole {
  STUDENT      // Can enroll, track progress, download certificates
  INSTRUCTOR   // Can create courses, review assignments, view analytics
  ADMIN        // Can approve courses, issue certificates, access fraud queue
}
```

**Guard Usage:**
```typescript
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
async approveCourse() { ... }
```

---

## Deployment Architecture

### Production Setup

```
┌─────────────────────────────────────────────────────────────┐
│                       Load Balancer (HTTPS)                  │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              NestJS Backend (3+ instances)                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ App 1: API + Event Poller + BullMQ Workers            │ │
│  │ App 2: API + Event Poller + BullMQ Workers            │ │
│  │ App 3: API + Event Poller + BullMQ Workers            │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
            ▼                            ▼
┌────────────────────────┐  ┌──────────────────────────────┐
│  PostgreSQL (Primary)  │  │  Redis (Cache + Queue)       │
│  + Read Replicas       │  │  + Sentinel (HA)             │
└────────────────────────┘  └──────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Stellar Network (RPC)                     │
│  Testnet: https://soroban-testnet.stellar.org              │
│  Mainnet: https://soroban-mainnet.stellar.org              │
└─────────────────────────────────────────────────────────────┘
```

**Environment Variables (Production):**
```bash
# Database
DATABASE_URL=postgresql://user:pass@db.internal:5432/hamplard?schema=public

# Redis
REDIS_HOST=redis.internal
REDIS_PORT=6379
REDIS_PASSWORD=...

# Stellar
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_NETWORK=mainnet
HAMPLARD_CONTRACT_ID=CA...

# AWS
AWS_S3_BUCKET=hamplard-prod-uploads
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Monitoring
SENTRY_DSN=https://...@sentry.io/...

# Security
JWT_SECRET={strong-random-secret}
TRUST_PROXY=1  # Behind load balancer
```

---

## Monitoring & Observability

### Health Checks

```bash
GET /health                      # DB + Redis ping
GET /health/checkpoint           # Event poller status
GET /health/detailed             # Full system status
```

### Logging (Pino)

```typescript
Logger levels: error | warn | info | debug
Structured JSON logs with request IDs
Correlation across services via X-Request-ID header
```

### Metrics (Sentry)

```typescript
- Error tracking (exceptions, stack traces)
- Performance monitoring (API response times)
- Transaction tracing (database queries)
- Custom events (enrollment_created, certificate_issued)
```

---

## Summary

Hamplard's backend implements a **hybrid blockchain architecture** that balances **decentralization** (payment verification, certificate immutability) with **performance** (progress tracking, content delivery).

**Key Design Decisions:**

1. **On-chain for Trust**: Financial transactions and certificates are anchored on Stellar
2. **Off-chain for Speed**: Content, progress, and assignments are in PostgreSQL
3. **Event-Driven Sync**: 5-second polling reconciles on-chain and off-chain state
4. **Comprehensive Verification**: Backend verifies transactions on-chain before accepting enrollments
5. **Fault Tolerance**: Durable checkpoint system ensures no events are missed across restarts

**Architecture Wins:**
- 🚀 **Performance**: Lesson progress updates don't hit the blockchain
- 🔒 **Security**: Payments are verified on-chain, not trusted from client
- 📊 **Auditability**: All critical events have an immutable blockchain trail
- 💪 **Resilience**: Event poller recovers from crashes without data loss
- 🌐 **Scalability**: Multiple backend instances can run concurrently

---

**Related Documentation:**
- `README.md` - API endpoints and setup instructions
- `prisma/schema.prisma` - Full database schema
- `TESTING_GUIDE.md` - Testing strategy and test data
- `IMPLEMENTATION_NOTES.md` - Feature implementation details
