# Hamplard Data Flow Diagrams

## Visual Guide to On-Chain/Off-Chain Data Flows

This document provides ASCII diagrams showing how data flows between the frontend, backend, and blockchain.

---

## Table of Contents
1. [System Architecture Overview](#system-architecture-overview)
2. [Enrollment Flow (Detailed)](#enrollment-flow-detailed)
3. [Certificate Issuance Flow](#certificate-issuance-flow)
4. [Event Polling Architecture](#event-polling-architecture)
5. [Data Consistency Model](#data-consistency-model)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND LAYER                                 │
│  ┌──────────────────┐              ┌─────────────────────────────────┐  │
│  │  Next.js Web App │              │   Freighter Wallet              │  │
│  │  - Student Portal│◄────────────►│   - Transaction Signing         │  │
│  │  - Instructor UI │              │   - Stellar Key Management      │  │
│  │  - Admin Panel   │              │   - Network: Testnet/Mainnet    │  │
│  └──────────────────┘              └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
            │                                           │
            │ HTTPS REST API                            │ Stellar RPC
            │ (JWT Auth)                                │ (Read-only)
            ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND LAYER (NestJS)                           │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                       API ENDPOINTS                                 │ │
│  │  /auth     /courses    /enrollments    /certificates   /lessons    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────┬───────────────┬──────────────┬────────────────────┐  │
│  │ Controllers │   Services    │   Guards     │   Interceptors     │  │
│  │  (HTTP)     │  (Business)   │  (Auth)      │  (Transform)       │  │
│  └─────────────┴───────────────┴──────────────┴────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                   BACKGROUND SERVICES                               │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │ │
│  │  │  EventsService│  │  BullMQ Jobs │  │  Notifications        │  │ │
│  │  │  (5s polling) │  │  (Async work)│  │  (Email/SMS/Push)     │  │ │
│  │  └──────────────┘  └──────────────┘  └────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │               INTEGRATION LAYER                                     ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐││
│  │  │StellarService│  │PrismaService │  │  UploadsService (S3)     │││
│  │  │(RPC Client)  │  │(PostgreSQL)  │  │  MeiliSearch (Search)    │││
│  │  └──────────────┘  └──────────────┘  └──────────────────────────┘││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
            │                                           │
            │ Prisma ORM                                │ Stellar RPC
            ▼                                           ▼
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│    DATA PERSISTENCE LAYER    │         │      BLOCKCHAIN LAYER             │
│                              │         │                                   │
│  ┌────────────────────────┐ │         │  ┌─────────────────────────────┐ │
│  │  PostgreSQL Database   │ │         │  │  Stellar Network            │ │
│  │  - Users               │ │         │  │  - Soroban Smart Contract   │ │
│  │  - Courses             │ │         │  │  - USDC Token               │ │
│  │  - Enrollments         │ │         │  │  - Ledger State             │ │
│  │  - Certificates        │ │         │  └─────────────────────────────┘ │
│  │  - LessonProgress      │ │         │                                   │
│  │  - ChainEvents         │ │         │  Contract Methods:                │
│  └────────────────────────┘ │         │  - register_course()              │
│                              │         │  - approve_course()               │
│  ┌────────────────────────┐ │         │  - enroll()                       │
│  │  Redis Cache           │ │         │  - mark_completed()               │
│  │  - Session tokens      │ │         │  - issue_certificate()            │
│  │  - Rate limits         │ │         │  - verify_certificate()           │
│  │  - BullMQ queues       │ │         │  - pause_course()                 │
│  └────────────────────────┘ │         │  - archive_course()               │
│                              │         │                                   │
│  ┌────────────────────────┐ │         │  Emitted Events:                  │
│  │  AWS S3 / Filesystem   │ │         │  - course_registered              │
│  │  - Videos              │ │         │  - course_approved                │
│  │  - Thumbnails          │ │         │  - student_enrolled               │
│  │  - PDFs                │ │         │  - course_completed               │
│  │  - Assignments         │ │         │  - certificate_issued             │
│  └────────────────────────┘ │         │  - certificate_revoked            │
└─────────────────────────────┘         └──────────────────────────────────┘
```

**Key Characteristics:**

| Aspect | Backend (Off-Chain) | Contract (On-Chain) |
|--------|---------------------|---------------------|
| **Storage** | PostgreSQL, S3 | Stellar ledger |
| **Speed** | <100ms per operation | 5-7 seconds per tx |
| **Cost** | Server resources | Gas fees (XLM) |
| **Mutability** | Can be updated | Immutable once written |
| **Privacy** | Access controlled | Public (readable by all) |
| **Use Cases** | Content, progress, assignments | Payments, enrollments, certificates |

---

## Enrollment Flow (Detailed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      STEP 1: PAYMENT (ON-CHAIN)                          │
└─────────────────────────────────────────────────────────────────────────┘

   Student Browser                 Freighter Wallet              Stellar Network
         │                               │                              │
         │  1. Click "Enroll Now"        │                              │
         │  courseId = "course-123"      │                              │
         │  price = 50 USDC              │                              │
         ├──────────────────────────────►│                              │
         │                               │                              │
         │  2. Build transaction:        │                              │
         │     enroll(courseId, amount)  │                              │
         │                               │                              │
         │  3. Prompt user to sign       │                              │
         │◄──────────────────────────────┤                              │
         │                               │                              │
         │  4. User confirms (enters pw) │                              ���
         ├──────────────────────────────►│                              │
         │                               │                              │
         │                               │  5. Submit signed tx         │
         │                               ├─────────────────────────────►│
         │                               │                              │
         │                               │  Contract executes:          │
         │                               │  ┌────────────────────────┐  │
         │                               │  │ a) Verify USDC balance │  │
         │                               │  │ b) Transfer 50 USDC:   │  │
         │                               │  │    - 40 to instructor  │  │
         │                               │  │    - 10 to platform    │  │
         │                               │  │ c) Record enrollment   │  │
         │                               │  │ d) Emit event:         │  │
         │                               │  │    student_enrolled(   │  │
         │                               │  │      courseId,         │  │
         │                               │  │      studentAddr,      │  │
         │                               │  │      50                │  │
         │                               │  │    )                   │  │
         │                               │  └────────────────────────┘  │
         │                               │                              │
         │                               │  6. Return txHash            │
         │                               │◄─────────────────────────────┤
         │                               │  "0xABC123..."               │
         │  7. Transaction confirmed     │                              │
         │◄──────────────────────────────┤                              │
         │  txHash = "0xABC123..."       │                              │
         │                               │                              │

┌─────────────────────────────────────────────────────────────────────────┐
│                 STEP 2: BACKEND REGISTRATION (OFF-CHAIN)                 │
└─────────────────────────────────────────────────────────────────────────┘

   Student Browser            Backend API                     Stellar RPC
         │                         │                              │
         │  8. POST /enrollments   │                              │
         │  {                      │                              │
         │    courseId: "course-123"│                             │
         │    txHash: "0xABC123..." │                             │
         │  }                      │                              │
         ├────────────────────────►│                              │
         │  Authorization: Bearer JWT                             │
         │                         │                              │
         │                         │  9. Verify JWT (extract userId)
         │                         │                              │
         │                         │  10. Query DB:               │
         │                         │  - Is course ACTIVE?         │
         │                         │  - Already enrolled?         │
         │                         │  - Prerequisites met?        │
         │                         │                              │
         │                         │  11. CRITICAL: Verify txHash │
         │                         │  verifyEnrollmentTransaction()
         │                         ├─────────────────────────────►│
         │                         │  getTransaction(txHash)      │
         │                         │                              │
         │                         │◄─────────────────────────────┤
         │                         │  Transaction details:        │
         │                         │  {                           │
         │                         │    status: "SUCCESS",        │
         │                         │    ledger: 12345,            │
         │                         │    events: [...]             │
         │                         │  }                           │
         │                         │                              │
         │                         │  12. getEvents(ledger)       │
         │                         ├─────────────────────────────►│
         │                         │                              │
         │                         │◄─────────────────────────────┤
         │                         │  Contract events:            │
         │                         │  {                           │
         │                         │    method: "enroll",         │
         │                         │    student: "GSTUDENT...",   │
         │                         │    courseId: "course-123",   │
         │                         │    amount: 50                │
         │                         │  }                           │
         │                         │                              │
         │                         │  13. Validate event data:    │
         │                         │  ✓ Student matches JWT user  │
         │                         │  ✓ CourseId matches request  │
         │                         │  ✓ Amount >= course.price    │
         │                         │  ✓ TxHash not already used   │
         │                         │                              │
         │                         │  14. Run fraud detection:    │
         │                         │  - Score: 25 (LOW)           │
         │                         │  - Action: ALLOW             │
         │                         │                              │
         │                         │  15. ATOMIC TRANSACTION:     │
         │                         │  BEGIN;                      │
         │                         │  INSERT Payment (txHash)     │
         │                         │  INSERT Enrollment           │
         │                         │  UPDATE Course (stats)       │
         │                         │  COMMIT;                     │
         │                         │                              │
         │                         │  16. Post-enrollment:        │
         │                         │  - Generate invoice PDF      │
         │                         │  - Track referral conversion │
         │                         │  - Init drip schedule        │
         │                         │  - Send notifications        │
         │                         │                              │
         │  17. HTTP 201 Created   │                              │
         │◄────────────────────────┤                              │
         │  {                      │                              │
         │    id: "enroll-456",    │                              │
         │    studentId: "user-789"│                              │
         │    courseId: "course-123"                              │
         │    amountPaid: 50,      │                              │
         │    txHash: "0xABC123...",                              │
         │    status: "ACTIVE",    │                              │
         │    progressPercent: 0   │                              │
         │  }                      │                              │
         │                         │                              │

┌─────────────────────────────────────────────────────────────────────────┐
│              STEP 3: EVENT RECONCILIATION (BACKGROUND)                   │
└─────────────────────────────────────────────────────────────────────────┘

   EventsService (Poller)      PostgreSQL                   Stellar RPC
         │                         │                              │
         │  (Runs every 5 seconds)                                │
         │                         │                              │
         │  18. Check checkpoint   │                              │
         ├────────────────────────►│                              │
         │  lastProcessedLedger: 12300                            │
         │◄────────────────────────┤                              │
         │                         │                              │
         │  19. Fetch events       │                              │
         ├────────────────────────────────────────────────────────►│
         │  fetchContractEvents(   │                              │
         │    startLedger: 12300,  │                              │
         │    limit: 100           │                              │
         │  )                      │                              │
         │                         │                              │
         │◄────────────────────────────────────────────────────────┤
         │  events: [              │                              │
         │    {                    │                              │
         │      ledger: 12345,     │                              │
         │      eventName: "student_enrolled",                    │
         │      payload: {         │                              │
         │        courseId: "course-123",                         │
         │        student: "GSTUDENT...",                         │
         │        amount: 50       │                              │
         │      }                  │                              │
         │    }                    │                              │
         │  ]                      │                              │
         │                         │                              │
         │  20. Save raw event     │                              │
         ├────────────────────────►│                              │
         │  INSERT ChainEvent      │                              │
         │  eventId = "12345-student_enrolled-0xABC123"           │
         │                         │                              │
         │  21. Check if duplicate │                              │
         │◄────────────────────────┤                              │
         │  (unique constraint)    │                              │
         │  → NOT duplicate        │                              │
         │                         │                              │
         │  22. Run handler:       │                              │
         │  handleStudentEnrolled()│                              │
         │                         │                              │
         │  23. Query enrollment   │                              │
         ├────────────────────────►│                              │
         │  WHERE studentId = ...  │                              │
         │    AND courseId = "course-123"                         │
         │                         │                              │
         │◄────────────────────────┤                              │
         │  Enrollment found:      │                              │
         │  id = "enroll-456"      │                              │
         │                         │                              │
         │  24. Skip stat update   │                              │
         │  (already incremented by API)                          │
         │                         │                              │
         │  25. Mark event processed                              │
         ├────────────────────────►│                              │
         │  UPDATE ChainEvent      │                              │
         │  SET processed = true   │                              │
         │                         │                              │
         │  26. Update checkpoint  │                              │
         ├────────────────────────►│                              │
         │  UPDATE EventPollerCheckpoint                          │
         │  SET lastProcessedLedger = 12346                       │
         │      lastProcessedCursor = "12345-1-0xABC123"          │
         │                         │                              │
         │                         │                              │
```

**Key Insights:**

1. **On-chain payment happens FIRST** (user can't fake payment)
2. **Backend verifies txHash** against blockchain (can't be spoofed)
3. **Event polling is reconciliation** (not primary registration)
4. **Stats updated ONCE** by API endpoint (events don't double-count)

---

## Certificate Issuance Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                PHASE 1: ELIGIBILITY CHECK (OFF-CHAIN)                    │
└─────────────────────────────────────────────────────────────────────────┘

    Admin Dashboard          Backend API               PostgreSQL
         │                        │                         │
         │  1. POST /certificates │                         │
         │  {                     │                         │
         │    studentId: "user-789"                         │
         │    courseId: "course-123"                        │
         │  }                     │                         │
         ├───────────────────────►│                         │
         │                        │                         │
         │                        │  2. Query enrollment    │
         │                        ├────────────────────────►│
         │                        │  WHERE studentId        │
         │                        │    AND courseId         │
         │                        │                         │
         │                        │◄────────────────────────┤
         │                        │  {                      │
         │                        │    status: "COMPLETED", │
         │                        │    progressPercent: 100,│
         │                        │    completedAt: "..."   │
         │                        │  }                      │
         │                        │                         │
         │                        │  3. Check exam          │
         │                        ├────────────────────────►│
         │                        │  ExamAttempt            │
         │                        │  WHERE studentId        │
         │                        │    AND passed = true    │
         │                        │                         │
         │                        │◄────────────────────────┤
         │                        │  Exam passed: ✓         │
         │                        │                         │
         │                        │  4. Check existing cert │
         │                        ├────────────────────────►│
         │                        │  Certificate            │
         │                        │  WHERE studentId, courseId
         │                        │                         │
         │                        │◄────────────────────────┤
         │                        │  None found ✓           │
         │                        │                         │

┌─────────────────────────────────────────────────────────────────────────┐
│                PHASE 2: CERTIFICATE GENERATION (OFF-CHAIN)               │
└─────────────────────────────────────────────────────────────────────────┘

                                │                         │
         │                      │  5. Generate cert ID    │
         │                      │  CERT-A1B2C3D4E5F6      │
         │                      │                         │
         │                      │  6. Create DB record    │
         │                      ├────────────────────────►│
         │                      │  INSERT Certificate     │
         │                      │  {                      │
         │                      │    id: "CERT-A1B2...",  │
         │                      │    studentId,           │
         │                      │    courseId,            │
         │                      │    courseTitle,         │
         │                      │    txHash: NULL,        │
         │                      │    issuedAt: now()      │
         │                      │  }                      │
         │                      │                         │
         │                      │  7. Render PDF:         │
         │  CertificatePdfService                         │
         │  - Load template for category (e.g. "Tailoring")
         │  - Insert student name, course title, date     │
         │  - Add signatures & branding                   │
         │  - Generate QR code (verification URL)         │
         │  → PDF buffer (binary)                         │
         │                      │                         │
         │                      │  8. Upload to S3        │
         │  UploadsService.saveBuffer()                   │
         │  → https://s3.../certificates/CERT-A1B2.pdf    │
         │                      │                         │
         │                      │  9. Update DB with URL  │
         │                      ├────────────────────────►│
         │                      │  UPDATE Certificate     │
         │                      │  SET pdfUrl = "s3://..."│
         │                      │                         │
         │                      │  10. Notify student     │
         │  NotificationsService                          │
         │  "🎓 Certificate Issued!"                      │
         │  Email + In-app + Push                         │
         │                      │                         │
         │  11. HTTP 201        │                         │
         │◄─────────────────────┤                         │
         │  {                   │                         │
         │    id: "CERT-A1B2..",│                         │
         │    studentId,        │                         │
         │    courseId,         │                         │
         │    pdfUrl: "s3://...",                         │
         │    txHash: null,     │  ← PENDING              │
         │    issuedAt: "..."   │                         │
         │  }                   │                         │
         │                      │                         │

┌─────────────────────────────────────────────────────────────────────────┐
│                 PHASE 3: BLOCKCHAIN ANCHORING (ON-CHAIN)                 │
└─────────────────────────────────────────────────────────────────────────┘

    Admin Browser           Freighter Wallet          Stellar Network
         │                        │                         │
         │  12. Click "Anchor     │                         │
         │      Certificate"      │                         │
         │  certificateId =       │                         │
         │    "CERT-A1B2..."      │                         │
         ├───────────────────────►│                         │
         │                        │                         │
         │                        │  13. Build tx:          │
         │                        │  issue_certificate(     │
         │                        │    certificateId,       │
         │                        │    studentAddress,      │
         │                        │    courseId             │
         │                        │  )                      │
         │                        │                         │
         │  14. Sign prompt       │                         │
         │◄───────────────────────┤                         │
         │                        │                         │
         │  15. Confirm           │                         │
         ├───────────────────────►│                         │
         │                        │                         │
         │                        │  16. Submit tx          │
         │                        ├────────────────────────►│
         │                        │                         │
         │                        │  Contract:              │
         │                        │  - Verify student enrolled
         │                        │  - Verify course completed
         │                        │  - Store certificate    │
         │                        │  - Emit: certificate_issued
         │                        │                         │
         │                        │  17. Return txHash      │
         │                        │◄────────────────────────┤
         │                        │  "0xDEF456..."          │
         │  18. Tx confirmed      │                         │
         │◄───────────────────────┤                         │
         │  txHash = "0xDEF456..."│                         │
         │                        │                         │

┌─────────────────────────────────────────────────────────────────────────┐
│                PHASE 4: TXHASH UPDATE (OFF-CHAIN)                        │
└─────────────────────────────────────────────────────────────────────────┘

    Admin Browser           Backend API              PostgreSQL
         │                        │                         │
         │  19. PATCH /certificates/:id/tx-hash            │
         │  {                     │                         │
         │    txHash: "0xDEF456..."                        │
         │  }                     │                         │
         ├───────────────────────►│                         │
         │                        │                         │
         │                        │  20. Update cert        │
         │                        ├────────────────────────►│
         │                        │  UPDATE Certificate     │
         │                        │  SET txHash = "0xDEF..."│
         │                        │                         │
         │  21. HTTP 200          │                         │
         │◄─────────────────────── │                        │
         │  Certificate now VALID │                         │
         │                        │                         │

┌─────────────────────────────────────────────────────────────────────────┐
│               PHASE 5: EVENT CONFIRMATION (BACKGROUND)                   │
└─────────────────────────────────────────────────────────────────────────┘

   EventsService             Stellar RPC            NotificationsService
         │                        │                         │
         │  (5 seconds later)     │                         │
         │                        │                         │
         │  22. Poll events       │                         │
         ├───────────────────────►│                         │
         │                        │                         │
         │◄───────────────────────┤                         │
         │  certificate_issued(   │                         │
         │    certificateId,      │                         │
         │    studentAddress,     │                         │
         │    courseId            │                         │
         │  )                     │                         │
         │                        │                         │
         │  23. handleCertificateIssued()                   │
         │  - Find student by address                       │
         │  - Send notification   │                         │
         ├─────────────────────────────────────────────────►│
         │  "🎓 Certificate is on-chain!"                   │
         │  Email + Push          │                         │
         │                        │                         │
```

**Certificate States:**

1. **PENDING**: Exists in DB, no txHash (not yet on-chain)
2. **VALID**: Has txHash, verifiable on-chain
3. **INVALID**: Revoked or not found on blockchain

---

## Event Polling Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    EVENT POLLER LIFECYCLE                                │
└─────────────────────────────────────────────────────────────────────────┘

    EventsService.onModuleInit()
              │
              ▼
    ┌────────────────────────┐
    │  1. Load Checkpoint    │
    │  from PostgreSQL       │
    └────────────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  Checkpoint exists?                        │
    ├────────────┬───────────────────────────────┤
    │   YES      │          NO (Cold Start)      │
    │            │                               │
    │  Resume at │      Start at:                │
    │  persisted │      latestLedger - 10        │
    │  ledger    │      (lookback buffer)        │
    └────────────┴───────────────────────────────┘
              │
              ▼
    ┌────────────────────────┐
    │  2. Start Interval     │
    │  Every 5 seconds       │
    │  (configurable)        │
    └────────────────────────┘
              │
              ▼
    ╔════════════════════════╗
    ║   POLLING LOOP         ║
    ╚════════════════════════╝
              │
              ▼
    ┌────────────────────────┐
    │  Re-entrancy Guard?    │
    │  if (isPolling) skip   │
    └────────────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  3. Fetch Events from RPC                  │
    │  fetchContractEvents(                      │
    │    startLedger: lastProcessedLedger,       │
    │    cursor: lastProcessedCursor || undefined│
    │  )                                         │
    └────────────────────────────────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  Response: { events: [...], latestLedger } │
    └────────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────┐
    │  Events array       │
    │  empty?             │
    ├──────────┬──────────┤
    │   YES    │    NO    │
    │          │          │
    │  Advance │  Process │
    │  to next │  each    │
    │  ledger  │  event   │
    └──────────┴──────────┘
              │
              ▼
    ╔════════════════════════╗
    ║   FOR EACH EVENT       ║
    ╚════════════════════════╝
              │
              ▼
    ┌────────────────────────┐
    │  4. Save Raw Event     │
    │  to ChainEvent table   │
    └────────────────────────┘
              │
              ▼
    ┌────────────────────────┐
    │  Duplicate?            │
    │  (unique eventId)      │
    ├──────────┬─────────────┤
    │   YES    │     NO      │
    │          │             │
    │  Skip    │  Process    │
    │  (return │  handler    │
    │   false) │  (return    │
    │          │   true)     │
    └──────────┴─────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  5. Run Event Handler                      │
    │  switch (eventName) {                      │
    │    case 'student_enrolled':                │
    │      handleStudentEnrolled(payload)        │
    │    case 'certificate_issued':              │
    │      handleCertificateIssued(payload)      │
    │    ...                                     │
    │  }                                         │
    └────────────────────────────────────────────┘
              │
              ├────────────┬─────────────────────┐
              │  SUCCESS   │       ERROR         │
              ▼            ▼                     │
    ┌──────────────┐  ┌──────────────────────┐  │
    │  Mark        │  │  Record Failure:     │  │
    │  processed   │  │  - Increment attempt │  │
    │  = true      │  │  - Save error msg    │  │
    │              │  │  - Set retryAt       │  │
    │              │  │    (exponential      │  │
    │              │  │     backoff)         │  │
    └──────────────┘  └──────────────────────┘  │
              │                │                 │
              └────────────────┴─────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  6. Advance Checkpoint                     │
    │  lastProcessedLedger = max(event.ledger+1) │
    │  lastProcessedCursor = event.pagingToken   │
    └────────────────────────────────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  7. Persist Checkpoint to DB               │
    │  (Best-effort, never blocks polling)       │
    └────────────────────────────────────────────┘
              │
              ▼
    ╔════════════════════════╗
    ║   END OF EVENT         ║
    ╚════════════════════════╝
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  8. Check Page Size                        │
    │  events.length < 100 ?                     │
    ├──────────────┬─────────────────────────────┤
    │   YES        │          NO                 │
    │  (Last page) │       (More pages)          │
    │              │                             │
    │  Clear       │      Keep cursor            │
    │  cursor,     │      for next page          │
    │  advance     │                             │
    │  to next     │                             │
    │  ledger      │                             │
    └──────────────┴─────────────────────────────┘
              │
              ▼
    ┌────────────────────────┐
    │  9. Update Checkpoint  │
    │  lastPolledAt = now()  │
    └────────────────────────┘
              │
              ▼
    ┌────────────────────────┐
    │  10. Release Guard     │
    │  isPolling = false     │
    └────────────────────────┘
              │
              ▼
    ╔════════════════════════╗
    ║   WAIT 5 SECONDS       ║
    ╚════════════════════════╝
              │
              └──────────► (Loop back to step 3)


┌─────────────────────────────────────────────────────────────────────────┐
│                      PARALLEL: RETRY MECHANISM                           │
└─────────────────────────────────────────────────────────────────────────┘

    Separate Interval (every 5s)
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  Query failed events:                      │
    │  WHERE processed = false                   │
    │    AND attemptCount < 5                    │
    │    AND (retryAt IS NULL                    │
    │         OR retryAt <= NOW())               │
    └────────────────────────────────────────────┘
              │
              ▼
    ┌────────────────────────────────────────────┐
    │  FOR EACH failed event:                    │
    │    runEventHandler(                        │
    │      id, eventName, payload, attemptCount  │
    │    )                                       │
    └────────────────────────────────────────────┘
              │
              ├────────────┬─────────────────────┐
              │  SUCCESS   │       ERROR         │
              ▼            ▼                     │
    ┌──────────────┐  ┌──────────────────────┐  │
    │  Mark        │  │  Increment attempt   │  │
    │  processed   │  │  (exponential        │  │
    │  = true      │  │   backoff)           │  │
    └──────────────┘  └──────────────────────┘  │
                              │                  │
                              ▼                  │
                      ┌──────────────────┐       │
                      │  attemptCount >= 5?      │
                      ├──────────┬───────┤       │
                      │   YES    │  NO   │       │
                      ▼          ▼       │       │
                 ┌─────────┐  ┌──────┐  │       │
                 │  DEAD   │  │ Retry│  │       │
                 │  LETTER │  │ later│  │       │
                 │  QUEUE  │  └──────┘  │       │
                 └─────────┘            │       │
                      │                 │       │
                      └─────────────────┴───────┘
```

**Key Features:**

- **Cursor-based pagination**: Resume mid-page after crashes
- **Re-entrancy guard**: Prevents overlapping polls
- **Exponential backoff**: Failed handlers retry with delays
- **Dead-letter queue**: Events that fail 5+ times need manual admin retry
- **Health monitoring**: Tracks consecutive checkpoint write failures

---

## Data Consistency Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CONSISTENCY GUARANTEES                              │
└─────────────────────────────────────────────────────────────────────────┘

                      Backend (PostgreSQL)          Contract (Stellar)
                              │                             │
                              │                             │
┌───────────────────────────────────────────────────────────────────────┐
│  ENROLLMENT CREATION                                                   │
├───────────────────────────────────────────────────────────────────────┤
│                              │                             │           │
│  User submits enrollment     │                             │           │
│  to contract first           │          ┌──────────────────┤           │
│                              │          │  1. Payment      │           │
│                              │          │     recorded     │           │
│                              │          │  2. Enrollment   │           │
│                              │          │     stored       │           │
│                              │          │  3. Event        │           │
│                              │          │     emitted      │           │
│                              │          └──────────────────┤           │
│                              │                             │           │
│  User sends txHash to API    │                             │           │
│         ├────────────────────►│                             │           │
│         │                     │                             │           │
│         │  Backend verifies   │  ◄──────RPC query──────────┤           │
│         │  txHash on-chain    │                             │           │
│         │  (comprehensive)    │                             │           │
│         │                     │                             │           │
│         │  If valid:          │                             │           │
│         │  ┌──────────────────┤                             │           │
│         │  │ 1. Payment       │                             │           │
│         │  │ 2. Enrollment    │                             │           │
│         │  │ 3. Course stats  │                             │           │
│         │  └──────────────────┤                             │           │
│         │   (ATOMIC)          │                             │           │
│         │                     │                             │           │
│         │                                                               │
│  Event poller detects enrollment event (5s later)                      │
│         │                     │                             │           │
│         │  Reconciliation:    │                             │           │
│         │  - Already exists?  │                             │           │
│         │    → Skip           │                             │           │
│         │  - Missing?         │                             │           │
│         │    → Log warning    │                             │           │
│                              │                             │           │
│  CONSISTENCY: Backend is source of truth for stats,                    │
│               blockchain is proof of payment                           │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│  PROGRESS TRACKING (100% OFF-CHAIN)                                    │
├───────────────────────────────────────────────────────────────────────┤
│                              │                             │           │
│  User watches lesson         │                             │           │
│         ├────────────────────►│                             │           │
│         │  PATCH /progress   │                             │           │
│         │  { watchedSecs }   │                             │           │
│         │                     │                             │           │
│         │  Backend updates:   │                             │           │
│         │  LessonProgress     │          No blockchain      │           │
│         │                     │          interaction        │           │
│         │                     │                             │           │
│  User completes lesson       │                             │           │
│         ├────────────────────►│                             │           │
│         │  POST /complete    │                             │           │
│         │                     │                             │           │
│         │  Backend:           │                             │           │
│         │  1. Mark completed  │                             │           │
│         │  2. Recalc progress │                             │           │
│         │  3. Check if 100%   │                             │           │
│         │                     │                             │           │
│         │  If 100%:           │                             │           │
│         │  - Set COMPLETED    │                             │           │
│         │  - Notify student   │                             │           │
│         │                     │                             │           │
│  CONSISTENCY: Backend is single source of truth                        │
│               (blockchain never involved)                              │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│  CERTIFICATE ISSUANCE (TWO-PHASE COMMIT)                               │
├───────────────────────────────────────────────────────────────────────┤
│                              │                             │           │
│  Admin issues certificate    │                             │           │
│         ├────────────────────►│                             │           │
│         │  POST /certificates│                             │           │
│         │                     │                             │           │
│         │  Backend:           │                             │           │
│         │  ┌──────────────────┤                             │           │
│         │  │ 1. Verify        │                             │           │
│         │  │    eligibility   │                             │           │
│         │  │ 2. Create record │                             │           │
│         │  │    (txHash=null) │                             │           │
│         │  │ 3. Generate PDF  │                             │           │
│         │  │ 4. Notify student│                             │           │
│         │  └──────────────────┤                             │           │
│         │                     │                             │           │
│         │  State: PENDING     │                             │           │
│         │                     │                             │           │
│  Admin anchors on-chain      │                             │           │
│         ├─────────────────────┼─────────────────────────────►│           │
│         │  Freighter wallet   │          issue_certificate()│           │
│         │  signs tx           │                             │           │
│         │                     │          ┌──────────────────┤           │
│         │                     │          │ Certificate      │           │
│         │                     │          │ stored           │           │
│         │                     │          └──────────────────┤           │
│         │                     │                             │           │
│         │◄────────────────────┼─────────────────────────────┤           │
│         │  txHash returned    │                             │           │
│         │                     │                             │           │
│  Admin updates backend       │                             │           │
│         ├────────────────────►│                             │           │
│         │  PATCH /tx-hash     │                             │           │
│         │  { txHash }         │                             │           │
│         │                     │                             │           │
│         │  Backend:           │                             │           │
│         │  UPDATE Certificate │                             │           │
│         │  SET txHash = ...   │                             │           │
│         │                     │                             │           │
│         │  State: VALID       │                             │           │
│         │                     │                             │           │
│  Event poller confirms (background)                                    │
│         │                     │  ◄──────Poll events────────┤           │
│         │                     │                             │           │
│         │  Notify student:    │                             │           │
│         │  "🎓 On-chain!"     │                             │           │
│                              │                             │           │
│  CONSISTENCY: Certificate valid when both DB record exists             │
│               AND txHash points to valid on-chain entry                │
└───────────────────────────────────────────────────────────────────────┘
```

**Consistency Rules:**

1. **Blockchain is authoritative for payments** (backend verifies, never trusts client)
2. **Backend is authoritative for enrollments** (after verification)
3. **Backend is sole source for progress** (too granular for blockchain)
4. **Certificates require both** (DB for metadata, blockchain for proof)

---

## Summary

The Hamplard architecture implements a **hybrid consistency model**:

- **On-chain (Stellar)**: Immutable financial events (payments, enrollments, certificates)
- **Off-chain (Backend)**: Mutable derived state (progress, assignments, analytics)
- **Sync mechanism**: Event poller reconciles both every 5 seconds

**Data Flow Patterns:**

| Operation | Direction | Trigger |
|-----------|-----------|---------|
| **Payment** | User → Blockchain → Backend | User signs tx, backend verifies |
| **Progress** | User → Backend (only) | Direct API calls |
| **Certificate** | Backend → Blockchain → Backend | Two-phase commit |
| **Verification** | Anyone → Backend ↔ Blockchain | Backend cross-checks on-chain |

**Key Architecture Principles:**

✅ **Verify, don't trust**: Backend validates all txHash values on-chain  
✅ **Atomic operations**: Payment + enrollment + stats in single transaction  
✅ **Idempotent handlers**: Events can be replayed without double-counting  
✅ **Durable checkpoints**: Crash recovery without missed events  
✅ **Eventual consistency**: Events reconcile within 5 seconds  

For implementation details, see `ARCHITECTURE.md`.
