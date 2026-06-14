# Hamplard — Backend Repo

> **NestJS API for Africa's practical skills online learning platform**

This is **Repo 2 of 3** in the Hamplard project:

| Repo | Description |
|------|-------------|
| `hamplard-contract` | Soroban smart contract (Rust) — payments + certificates |
| `hamplard-backend` ← you are here | NestJS REST API — content, progress, users |
| `hamplard-frontend` | Next.js — student and instructor portal |

---

## What This Backend Does

The backend is the content and user management layer of Hamplard. It handles everything that does not need to be on-chain:

- **User management** — student and instructor profiles, role management
- **Course content** — course creation, module and lesson organisation, video management
- **Progress tracking** — lesson-level watch progress, enrollment percentage, completion detection
- **Assignment workflow** — practical submission upload and instructor review
- **Certificate issuance** — triggers on-chain certificate after verifying 100% completion
- **Event polling** — listens to the Stellar contract for enrollment and certificate events
- **File uploads** — thumbnails, lesson videos, downloadable resources, assignment submissions
- **Notifications** — in-app and email alerts for all platform activity

---

## What Lives Where

| Responsibility | Backend | Contract |
|---|---|---|
| Course content (videos, text) | ✓ | — |
| Student progress tracking | ✓ | — |
| User profiles | ✓ | — |
| Assignment submission + review | ✓ | — |
| Course payment processing | — | ✓ |
| Enrollment record (trustless) | — | ✓ |
| Certificate of completion | — | ✓ |
| Certificate verification (public) | ✓ (cross-checks) | ✓ |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    NestJS Application                         │
│                                                              │
│  ┌────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────────┐   │
│  │ Courses│ │ Lessons │ │Enrollm. │ │  Certificates    │   │
│  │ Module │ │ Module  │ │ Module  │ │  Module          │   │
│  └────────┘ └─────────┘ └─────────┘ └──────────────────┘   │
│                                                              │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ Assignments │ │   Uploads    │ │     Events (poller)  │  │
│  │   Module    │ │   Module     │ │     5s Stellar cron  │  │
│  └─────────────┘ └──────────────┘ └──────────────────────┘  │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │  PrismaService   │  │        StellarService            │  │
│  │  (PostgreSQL)    │  │  (RPC + contract simulation)     │  │
│  └──────────────────┘  └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Module Overview

| Module | Responsibility |
|--------|---------------|
| `AuthModule` | Sign-In With Stellar (nonce + JWT). Supports STUDENT and INSTRUCTOR roles at registration. |
| `UsersModule` | Profile management, instructor analytics dashboard |
| `CoursesModule` | Full CRUD, DRAFT → PENDING → ACTIVE approval workflow, category browsing |
| `LessonsModule` | Lesson and module creation, video progress tracking, completion detection |
| `EnrollmentsModule` | Register on-chain enrollments in DB, query per-student progress |
| `AssignmentsModule` | Practical assignment creation, student submission, instructor review |
| `CertificatesModule` | Trigger certificate issuance, on-chain verification cross-check, revocation |
| `EventsModule` | Stellar RPC event poller (5s cron) — syncs on-chain events to DB |
| `NotificationsModule` | In-app + email (Nodemailer) notifications |
| `UploadsModule` | Multer file uploads — video (500MB), thumbnail (5MB), resource (50MB), assignment (100MB) |
| `HealthModule` | `/health` DB ping endpoint |

---

## API Endpoints

All endpoints prefixed with `/api/v1`. Protected routes require `Authorization: Bearer <JWT>`.

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/nonce?address=G...` | Get challenge nonce |
| `POST` | `/auth/login` | Submit signed nonce, receive JWT. Pass `role: INSTRUCTOR` to register as instructor. |

### Users
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/users/me` | ✓ | Get authenticated user profile + enrollments + certificates |
| `PATCH` | `/users/me` | ✓ | Update name, email, bio, avatar |
| `GET` | `/users/me/instructor-stats` | ✓ INSTRUCTOR | Revenue + enrollment analytics |
| `GET` | `/users/:address/public` | — | Public instructor profile |

### Courses
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/courses` | — | Browse active courses (filter: category, level, search) |
| `GET` | `/courses/categories` | — | List all categories with counts |
| `GET` | `/courses/:id` | — | Full course detail with modules and lessons |
| `POST` | `/courses` | ✓ INSTRUCTOR | Create course draft |
| `PATCH` | `/courses/:id` | ✓ INSTRUCTOR | Update course details |
| `POST` | `/courses/:id/submit` | ✓ INSTRUCTOR | Submit for admin review |
| `GET` | `/courses/admin/pending` | ✓ ADMIN | List courses awaiting approval |
| `POST` | `/courses/:id/approve` | ✓ ADMIN | Approve a pending course |
| `POST` | `/courses/:id/reject` | ✓ ADMIN | Reject with feedback |

### Lessons
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/lessons/:id` | ✓ | Get lesson content |
| `POST` | `/lessons/modules` | ✓ INSTRUCTOR | Create a course module |
| `POST` | `/lessons` | ✓ INSTRUCTOR | Add a lesson to a module |
| `POST` | `/lessons/:id/complete` | ✓ | Mark lesson complete (recalculates progress) |
| `PATCH` | `/lessons/:id/progress` | ✓ | Update video watch position |

### Enrollments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/enrollments` | ✓ | Register on-chain enrollment after Freighter tx |
| `GET` | `/enrollments/my` | ✓ | All enrollments for current student |
| `GET` | `/enrollments/:courseId` | ✓ | Single enrollment with full lesson progress |
| `GET` | `/enrollments/:courseId/check` | ✓ | Is user enrolled in this course? |

### Assignments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/assignments/lesson/:lessonId` | ✓ | Get assignment for a lesson |
| `POST` | `/assignments` | ✓ INSTRUCTOR | Create assignment for a lesson |
| `POST` | `/assignments/:id/submit` | ✓ | Student submits practical work |
| `POST` | `/assignments/submissions/:id/review` | ✓ INSTRUCTOR | Approve or reject submission |
| `GET` | `/assignments/my/submissions` | ✓ | Student's all submissions |
| `GET` | `/assignments/instructor/pending` | ✓ INSTRUCTOR | All pending reviews |

### Certificates
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/certificates/verify/:id` | — | **Public** — verify certificate by ID |
| `GET` | `/certificates/:id` | — | **Public** — get certificate details |
| `GET` | `/certificates/my/all` | ✓ | Student's certificates |
| `POST` | `/certificates` | ✓ ADMIN | Issue certificate for completed student |
| `PATCH` | `/certificates/:id/tx-hash` | ✓ ADMIN | Update on-chain tx hash |
| `POST` | `/certificates/:id/revoke` | ✓ ADMIN | Revoke a certificate |

### Uploads
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/uploads/thumbnail` | ✓ | Upload course thumbnail (max 5MB, image) |
| `POST` | `/uploads/video` | ✓ | Upload lesson video (max 500MB) |
| `POST` | `/uploads/resource` | ✓ | Upload downloadable resource (max 50MB) |
| `POST` | `/uploads/assignment` | ✓ | Upload assignment submission (max 100MB) |

### Events, Notifications, Health — standard across all Hamplard repos

---

## Project Structure

```
hamplard-backend/
├── .env.example
├── .gitignore
├── nest-cli.json
├── package.json
├── tsconfig.json
├── README.md
│
├── prisma/
│   └── schema.prisma              ← Full schema (13 models)
│
└── src/
    ├── main.ts
    ├── app.module.ts
    │
    ├── common/
    │   ├── prisma/                ← Global PrismaService
    │   ├── stellar/               ← Global StellarService
    │   ├── filters/               ← HttpExceptionFilter
    │   ├── interceptors/          ← TransformInterceptor
    │   ├── guards/                ← JwtAuthGuard, RolesGuard
    │   └── decorators/            ← @CurrentUser(), @Roles()
    │
    └── modules/
        ├── auth/                  ← Sign-In With Stellar + JWT + role at registration
        ├── users/                 ← Profiles + instructor analytics
        ├── courses/               ← CRUD + DRAFT→PENDING→ACTIVE workflow + spec
        ├── lessons/               ← Content + watch progress + completion detection
        ├── enrollments/           ← On-chain enrollment sync + progress queries
        ├── assignments/           ← Practical work upload + instructor review
        ├── certificates/          ← Issuance + on-chain verification + spec
        ├── events/                ← Stellar RPC poller (5s cron)
        ├── notifications/         ← In-app + Nodemailer email
        ├── uploads/               ← Multer file upload handlers
        └── health/                ← DB health check
```

---

## Prisma Schema Overview

```
User ─────────────────────────────────────────────────────────┐
  ├── Course[]         (as instructor)                         │
  ├── Enrollment[]     (as student)                            │
  ├── AssignmentSubmission[]                                   │
  ├── Certificate[]                                            │
  └── Notification[]                                           │
                                                               │
Course ──────────────────────────────────────────────────────┐ │
  ├── CourseModule[]                                          │ │
  │     └── Lesson[]                                         │ │
  │           ├── Assignment?                                 │ │
  │           │     └── AssignmentSubmission[]               │ │
  │           └── LessonProgress[]                           │ │
  ├── Enrollment[]                                            │ │
  ├── Certificate[]                                           │ │
  └── ChainEvent[]                                            │ │
```

---

## Course Lifecycle

```
Instructor creates course   → status: DRAFT
Instructor uploads content  → (lessons, modules added via API)
Instructor registers on-chain → register_course() via Freighter
Instructor submits for review → POST /courses/:id/submit → PENDING
Admin reviews course           → GET /courses/admin/pending
Admin approves                 → POST /courses/:id/approve → ACTIVE
                                  + approve_course() called on-chain
Students can now enroll        → enroll() via Freighter
```

## Certificate Lifecycle

```
Student completes all lessons → progressPercent = 100
Backend marks enrollment COMPLETED
Admin calls POST /certificates → DB record created
Admin calls issue_certificate() on Stellar → on-chain certificate
Admin calls PATCH /certificates/:id/tx-hash → updates DB with txHash
Student can share /certificates/verify/:id → public verification
```

---

## Setup

```bash
cp .env.example .env   # fill in your values
npm install
npx prisma migrate dev --name init
npx prisma generate
npm run start:dev
```

API: `http://localhost:3000/api/v1`
Swagger: `http://localhost:3000/docs`

---

## Running Tests

```bash
npm run test
npm run test:cov
```

---

## Production Checklist

- [ ] Replace in-memory nonce store with Redis
- [ ] Wire up `Keypair.verify()` in `auth.service.ts`
- [ ] Swap local file upload (UploadsModule) for AWS S3 or Cloudinary
- [ ] Persist `lastProcessedLedger` in DB for crash recovery
- [ ] Set strong `JWT_SECRET`
- [ ] Set `CORS_ORIGIN` to frontend production URL
- [ ] Use HTTPS behind nginx or Caddy

---

## License

MIT
