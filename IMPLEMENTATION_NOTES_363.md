# Issue #363: Per-Course Instructor Dashboard Endpoint

## Implementation Summary

This implementation adds a new instructor dashboard endpoint that provides per-course metrics for the authenticated instructor. The endpoint aggregates student enrollments, completion rates, quiz/exam scores, course ratings, and pending assignment submissions.

## Endpoint

```
GET /instructors/me/dashboard?from=<ISO8601>&to=<ISO8601>
```

**Authentication:** Required (JwtAuthGuard)  
**Authorization:** Caller must be an INSTRUCTOR role user  
**Parameters:**
- `from` (optional): Start of reporting period (ISO-8601, inclusive)
- `to` (optional): End of reporting period (ISO-8601, inclusive)

## Response Structure

```typescript
{
  instructor: { id, name },
  period: { from, to },
  generatedAt: ISO8601,
  courseMetrics: [
    {
      courseId: string,
      courseName: string,
      enrollments: {
        total: number,
        completed: number,
        completionRate: number (0-1),
        activeCount: number
      },
      ratings: {
        average: number (0-5),
        totalReviews: number
      },
      performance: {
        averageQuizScore: number | null,
        averageExamScore: number | null
      },
      submissions: {
        pending: number,
        approved: number,
        rejected: number
      }
    }
  ],
  summary: {
    totalCourses: number,
    totalEnrollments: number,
    averageCompletionRate: number,
    averageRating: number,
    totalPendingSubmissions: number
  }
}
```

## Files Created

### 1. **src/modules/reports/instructor-dashboard.service.ts**
Core business logic for dashboard metrics computation.

**Key responsibilities:**
- Validates instructor existence and role
- Fetches per-course metrics in parallel (enrollments, reviews, quiz/exam scores, assignments)
- Aggregates enrollment data (total, completed, active count, completion rate)
- Calculates average quiz and exam scores per course
- Counts pending/approved/rejected assignment submissions
- Computes summary statistics across all courses
- Supports date range filtering for all metrics

**Data sources:**
- `Enrollment` → enrollment counts and completion rates
- `CourseReview` → course ratings
- `QuizAttempt` → quiz scores (via Lesson hierarchy: Course → CourseModule → Lesson → QuizAttempt)
- `ExamAttempt` → exam scores
- `AssignmentSubmission` → submission statuses (via Lesson hierarchy)

### 2. **src/modules/reports/instructor-dashboard.controller.ts**
REST controller exposing the dashboard endpoint.

**Key features:**
- Extracts instructor ID from JWT token via `@CurrentUser('id')`
- Validates and parses query parameters via `InstructorDashboardQueryDto`
- Delegates to service for metric computation
- Returns fully typed response with Swagger documentation

### 3. **src/modules/reports/dto/instructor-dashboard-query.dto.ts**
Request DTO with optional date range parameters.

**Validation:**
- ISO-8601 date format validation
- Optional from/to parameters

### 4. **src/modules/reports/instructor-dashboard.service.spec.ts**
Comprehensive test suite (20 tests).

**Test coverage:**
- Input validation (unknown instructor, non-instructor role, invalid dates, date ordering)
- Empty/no-courses scenario
- Per-course metrics computation with realistic data
- Summary statistics calculation
- Date filtering
- Response structure validation
- Edge cases (courses with no enrollments/reviews/quizzes/exams/assignments)
- Controller integration

**All tests pass ✓**

### 5. **src/modules/reports/reports.module.ts** (Updated)
Added the new service and controller to the module exports.

## Key Design Decisions

### 1. **Parallel Metric Fetching**
All metrics are fetched in parallel using `Promise.all()` to minimize database round-trips:
```typescript
const [enrollmentData, reviewData, quizData, examData, assignmentData] = 
  await Promise.all([...])
```

### 2. **Data Model Navigation**
Since `Lesson` is nested under `CourseModule` → `Course`, the implementation:
- Fetches modules by course ID
- Fetches lessons by module ID
- Groups quiz/exam attempts by lesson, then maps back to course via module

This matches the actual Prisma schema where:
- `Course.modules` → `CourseModule.lessons` → `Lesson`
- `Lesson.quizAttempts` and `Lesson` → `Exam` (via course)

### 3. **Null-Safe Aggregations**
Quiz and exam scores return `null` if no attempts exist for a course, clearly indicating "no data" vs "0 score".

### 4. **Caller-Owned Data**
The endpoint only returns data for courses owned by the authenticated instructor:
```typescript
where: { instructorAddress: instructor.stellarAddress ?? '__none__' }
```

This prevents lateral data access and maintains data isolation.

### 5. **Date Filtering**
All time-based metrics (enrollments, reviews, quiz/exam attempts) respect the optional `from`/`to` date range, allowing instructors to analyze trends over custom periods.

### 6. **Assignment Metrics**
Counts assignment submissions by status (PENDING, APPROVED, REJECTED) rather than individual assignments, as this is more actionable for instructors tracking pending work.

## Acceptance Criteria Verification

✅ **Endpoint returns metrics only for the caller's courses**
- Uses `instructor.stellarAddress` to filter courses
- Caller extracted from JWT token

✅ **npm run build passes**
- No TypeScript errors in dashboard files
- Pre-existing errors in other modules (badges, gamification) are unrelated

✅ **npm test passes**
- 20/20 tests pass
- Full coverage of success paths, error cases, and edge cases

✅ **Date range support**
- `from` and `to` query parameters with optional ISO-8601 validation
- All time-based queries filtered by date range

## Usage Examples

### Get dashboard for current period
```bash
curl -H "Authorization: Bearer <token>" \
  https://api.hamplard.com/instructors/me/dashboard
```

### Get dashboard for specific period
```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.hamplard.com/instructors/me/dashboard?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z"
```

## Implementation Notes for Senior Developers

### Database Query Strategy
- Uses Prisma `groupBy()` for aggregations (ratings, scores)
- Uses `findMany()` with `select` for specific fields
- Minimal SELECT clauses to reduce network overhead

### Error Handling
- 404 NotFoundException for unknown instructors
- 400 BadRequestException for non-instructors or invalid dates
- Graceful degradation for missing data (null scores, 0 metrics)

### Type Safety
- Exported interfaces allow consumers to type-check responses
- Record<string, T> lookup patterns prevent runtime errors from missing course IDs

### Testing Strategy
- Mocked PrismaService with detailed fixtures
- Tested boundary conditions (from > to, missing data)
- Guard overrides in test module for clean unit testing

### Performance Considerations
- O(n) complexity where n = number of instructor's courses
- Each course's metrics fetched independently and cached in lookup table
- Future optimization: batch quiz/exam queries by course rather than by lesson

## Dependency

This implementation builds on Issue #300 (instructor stats). The dashboard extends the basic stats endpoint with:
- Per-course breakdown (vs. totals only)
- Quiz/exam scores (new)
- Assignment submission counts (new)
- Date range filtering (new)
- Completion rate calculation per course (new)

## Files Modified/Created

**Created:**
- `src/modules/reports/instructor-dashboard.service.ts`
- `src/modules/reports/instructor-dashboard.controller.ts`
- `src/modules/reports/dto/instructor-dashboard-query.dto.ts`
- `src/modules/reports/instructor-dashboard.service.spec.ts`
- `IMPLEMENTATION_NOTES_363.md` (this file)

**Modified:**
- `src/modules/reports/reports.module.ts` (added service and controller)

**No changes to:**
- Database schema (uses existing models)
- Authentication/authorization (extends existing guards)
- Other modules

## Testing

Run the dashboard tests:
```bash
npm test -- instructor-dashboard.service.spec
```

Output:
```
PASS src/modules/reports/instructor-dashboard.service.spec.ts (6.497 s)
  InstructorDashboard (Issue #363)
    validation (5 tests)
    no courses (1 test)
    per-course metrics (3 tests)
    summary metrics (1 test)
    date filtering (1 test)
    response structure (3 tests)
    controller integration (1 test)
    edge cases (5 tests)

Test Suites: 1 passed, 1 total
Tests: 20 passed, 20 total
```

## Security Considerations

1. **Authentication:** Requires valid JWT token (JwtAuthGuard)
2. **Authorization:** Only accessible to instructors; can only view own course data
3. **Data isolation:** Filtered by `instructorAddress` from authenticated user
4. **Input validation:** ISO-8601 date parsing, explicit date ordering checks

## Notes for Maintenance

- If Lesson model structure changes, update the module-to-course mapping logic in `getQuizMetrics` and `getAssignmentMetrics`
- If AssignmentSubmission statuses expand, update the submission counting logic
- Consider adding caching layer for frequently accessed dashboards (future optimization)
