# Endpoint permissions

This matrix documents the current controller guards and ownership checks. Paths
are relative to the configured API prefix (default `/api/v1`). Endpoints with
the same access rule are grouped in a row; every route is listed.

## Legend

- **✓**: allowed by the controller's authentication/role guards.
- **✓\***: allowed only for the authenticated resource owner (an admin is
  allowed where the route also admits admins).
- **—**: denied by the route's authentication/role guards.
- **Signed**: no user login, but a valid signed URL or webhook signature is
  required.
- A `JwtAuthGuard` without `RolesGuard` allows any authenticated role. It does
  not grant access to another user's records: routes pass the current user ID
  to the service or check ownership there.
- `OptionalJwtAuthGuard` allows anonymous requests and supplies identity only
  when a valid token is present. Routes with no authentication guard are
  anonymous unless the signed-URL/webhook check applies.
- The global `RoleThrottlerGuard` applies rate limits; it does not replace
  endpoint authentication or role guards.
- Instructor-owner means the instructor owns the referenced course/resource;
  instructor-other means an instructor who does not. Role decorators alone do
  not establish ownership. Where a route accepts instructors and an owner-bound
  resource, the service must enforce the owner check; admins bypass it only
  where the route admits admins.

## Public and optional-authentication endpoints

| Endpoint(s) | Anonymous | Student | Instructor-owner | Instructor-other | Admin | Ownership / condition |
|---|---:|---:|---:|---:|---:|---|
| `GET /health`, `GET /health/checkpoint` | ✓ | ✓ | ✓ | ✓ | ✓ | Public health data |
| `GET /auth/nonce`, `POST /auth/login`, `POST /auth/refresh` | ✓ | ✓ | ✓ | ✓ | ✓ | Authentication/bootstrap endpoints |
| `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/google/exchange`, `POST /auth/google/token` | ✓ | ✓ | ✓ | ✓ | ✓ | Feature-flag/provider checks still apply |
| `GET /courses`, `GET /courses/categories`, `GET /courses/:id`, `GET /courses/:id/checkout` | ✓ | ✓ | ✓ | ✓ | ✓ | Course visibility and viewer-specific detail are applied by the course service |
| `GET /courses/:id/prerequisites`, `GET /courses/:id/announcements`, `GET /courses/:id/recommendations`, `GET /courses/search/autocomplete` | ✓ | ✓ | ✓ | ✓ | ✓ | Announcements accept optional identity; visibility is service-controlled |
| `GET /courses/:courseId/reviews` | ✓ | ✓ | ✓ | ✓ | ✓ | Public review listing |
| `GET /discussions/lessons/:lessonId/questions`, `GET /discussions/questions/:questionId`, `GET /discussions/comments/discussion/:discussionId`, `GET /discussions/comments/:id` | ✓ | ✓ | ✓ | ✓ | ✓ | The last route accepts optional identity |
| `GET /lessons/:lessonId/questions` | ✓ | ✓ | ✓ | ✓ | ✓ | Public lesson-question listing |
| `GET /bundles`, `GET /bundles/:id` | ✓ | ✓ | ✓ | ✓ | ✓ | Public bundle catalog |
| `GET /certificates/verify/:id`, `GET /certificates/:id`, `GET /certificates/share/:token`, `GET /certificates/share/:token/metadata` | ✓ | ✓ | ✓ | ✓ | ✓ | Share links are token-scoped |
| `GET /badges/catalog`, `GET /badges/catalog/active`, `GET /badges/students/:studentId/showcase` | ✓ | ✓ | ✓ | ✓ | ✓ | Public catalog/showcase reads |
| `GET /live-sessions/upcoming`, `GET /live-sessions/:id` | ✓ | ✓ | ✓ | ✓ | ✓ | Optional JWT; returned content may vary by viewer |
| `GET /search`, `POST /search`, `GET /search/freshness/:courseId` | ✓ | ✓ | ✓ | ✓ | ✓ | Public search/read endpoints |
| `GET /gamification/leaderboard` | ✓ | ✓ | ✓ | ✓ | ✓ | Public leaderboard |
| `POST /referrals/validate` | ✓ | ✓ | ✓ | ✓ | ✓ | Public code validation |
| `GET /uploads/*` | Signed | Signed | Signed | Signed | Signed | A valid signed URL is required |
| `POST /notifications/sms/callback` | Signed | Signed | Signed | Signed | Signed | Webhook signature is verified; this is not a user-role endpoint |

## Authenticated user endpoints

These routes require a valid session but have no role restriction unless
otherwise noted. “Own record” means the handler/service scopes the operation to
the current user.

| Endpoint(s) | Anonymous | Student | Instructor-owner | Instructor-other | Admin | Ownership / condition |
|---|---:|---:|---:|---:|---:|---|
| `GET /queue/jobs/:id` | — | ✓* | ✓* | ✓* | ✓* | Job status is requested with the caller's user ID |
| `POST /analytics/events`, `POST /analytics/events/batch` | — | ✓ | ✓ | ✓ | ✓ | Event attribution uses the authenticated user |
| `POST /checkout/quote` | — | ✓* | ✓* | ✓* | ✓* | Checkout quote is created for the authenticated student |
| `GET /assignments/lesson/:lessonId`, `POST /assignments/:id/submit`, `GET /assignments/my/submissions` | — | ✓* | ✓* | ✓* | ✓* | Submission reads/actions are scoped to the caller; lesson access rules apply |
| `POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/wallet/link-nonce`, `POST /auth/wallet/link`, `POST /auth/wallet/unlink` | — | ✓* | ✓* | ✓* | ✓* | Operates on the caller's account/session/wallet |
| `POST /otp/send`, `POST /otp/verify`, `GET /otp/status`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all` | — | ✓* | ✓* | ✓* | ✓* | Operates on the caller's phone/session |
| `POST /auth/2fa/setup`, `POST /auth/2fa/enable`, `POST /auth/2fa/disable`, `GET /auth/2fa/status`, `POST /auth/2fa/recovery-codes` | — | — | ✓ | ✓ | ✓ | Instructor or admin role plus the 2FA guard |
| `POST /bundles/:id/enroll` | — | ✓ | ✓ | ✓ | ✓ | Authenticated enrollment; eligibility is service-controlled |
| `POST /certificates/:id/share`, `GET /certificates/my/all`, `GET /certificates/:id/download` | — | ✓* | ✓* | ✓* | ✓* | Share/download access is checked against the certificate holder |
| `POST /coupons/validate`, `POST /coupons/redeem` | — | ✓* | ✓* | ✓* | ✓* | Validation/redemption is performed for the caller |
| `POST /discussions/lessons/:lessonId/questions`, `POST /discussions/questions/:questionId/answers`, `PATCH /discussions/answers/:answerId/best`, `POST /discussions/comments` | — | ✓ | ✓ | ✓ | ✓ | Authenticated participation; author/course rules are service-controlled |
| `POST /lessons/:lessonId/questions`, `POST /questions/:id/answers`, `PATCH /answers/:id/best` | — | ✓* | ✓* | ✓* | ✓* | Best-answer action is limited by the service to the question author or admin |
| `GET /lessons/:id`, `POST /lessons/:id/complete`, `PATCH /lessons/:id/progress`, `GET /lessons/courses/:courseId/drip-schedule` | — | ✓* | ✓* | ✓* | ✓* | Lesson content is checked for drip/enrollment access; progress is caller-scoped |
| `POST /disputes`, `GET /disputes/my`, `GET /disputes/my/:id` | — | ✓* | ✓* | ✓* | ✓* | “My” routes are requester-scoped |
| `POST /enrollments`, `GET /enrollments/my`, `GET /enrollments/:courseId`, `GET /enrollments/:courseId/check`, `GET /enrollments/:courseId/check-prerequisites` | — | ✓* | ✓* | ✓* | ✓* | Reads/checks use the current user's enrollment identity |
| `POST /refunds`, `GET /refunds/my`, `GET /refunds/:id` | — | ✓* | ✓* | ✓* | ✓* | Refund request/status access is owner-scoped; admin access is also supported by the service |
| `GET /exams/course/:courseId`, `GET /exams/:id/eligibility`, `POST /exams/:id/submit`, `GET /exams/:id/history` | — | ✓* | ✓* | ✓* | ✓* | Eligibility, attempts, and history are enrollment/user-scoped |
| `GET /quizzes/lessons/:lessonId/questions`, `GET /quizzes/questions/:id` | — | ✓ | ✓ | ✓ | ✓ | Authenticated quiz-question reads |
| `GET /feature-flags/:key/evaluate`, `GET /feature-flags/evaluate/all` | — | ✓ | ✓ | ✓ | ✓ | Authenticated evaluation; caller identity is passed to the service |
| `GET /invoices/my`, `GET /invoices/:id/download` | — | ✓* | ✓* | ✓* | ✓* | Invoice owner or admin |
| `GET /payouts/instructor/:instructorId`, `GET /payouts/instructor/:instructorId/balance`, `GET /payouts/instructor/:instructorId/statement` | — | ✓* | ✓* | — | ✓* | Service permits the named instructor or an admin |
| `POST /moderation/flags` | — | ✓ | ✓ | ✓ | ✓ | Authenticated users may submit flags |
| `GET /notifications`, `GET /notifications/unread-count`, `GET /notifications/unread/count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`, `POST /notifications/devices/register`, `GET /notifications/preferences`, `PATCH /notifications/preferences/:type`, `PATCH /notifications/digest-preference` | — | ✓* | ✓* | ✓* | ✓* | All notification state belongs to the caller |
| `POST /live-sessions`, `PATCH /live-sessions/:id`, `DELETE /live-sessions/:id`, `POST /live-sessions/:id/rsvp`, `DELETE /live-sessions/:id/rsvp` | — | ✓* | ✓* | ✓* | ✓* | The live-session service checks host/attendee ownership and eligibility |
| `POST /privacy/account/deactivate`, `POST /privacy/account/reactivate`, `DELETE /privacy/account` | — | ✓* | ✓* | ✓* | ✓* | Operates on the authenticated account |
| `POST /privacy/data-exports`, `GET /privacy/data-exports`, `GET /privacy/data-exports/:jobId`, `GET /privacy/data-exports/:jobId/download` | — | ✓* | ✓* | ✓* | ✓* | Export jobs and downloads are caller-scoped |
| `POST /quizzes/lessons/:lessonId/attempts`, `GET /quizzes/lessons/:lessonId/attempts/history`, `POST /quizzes/lessons/:lessonId/sessions`, `GET /quizzes/sessions/:sessionId`, `POST /quizzes/sessions/:sessionId/submit` | — | ✓* | ✓* | ✓* | ✓* | Attempts and sessions are scoped to the caller |
| `POST /referrals/code`, `GET /referrals/code`, `GET /referrals/status`, `GET /referrals/rewards`, `POST /referrals/rewards/preview`, `POST /referrals/rewards/redeem`, `PATCH /referrals/code/deactivate` | — | ✓* | ✓* | ✓* | ✓* | Referral code/reward state is caller-scoped |
| `POST /reports`, `GET /reports/mine`, `GET /reports/mine/:id` | — | ✓* | ✓* | ✓* | ✓* | Reporter-owned records |
| `POST /courses/:courseId/reviews`, `PATCH /courses/:courseId/reviews/me`, `DELETE /courses/:courseId/reviews/me` | — | ✓* | ✓* | ✓* | ✓* | Review author and enrollment requirements are checked by the service |
| `GET /users/me`, `PATCH /users/me`, `GET /users/me/instructor-stats`, `GET /instructors/me/dashboard` | — | ✓* | ✓* | ✓* | ✓* | Caller-specific profile/dashboard data |
| `GET /users/:address/public` | — | ✓ | ✓ | ✓ | ✓ | Still requires JWT despite “public” in the path; profile address may identify another user |
| `POST /wishlist`, `GET /wishlist`, `DELETE /wishlist/:courseId` | — | ✓* | ✓* | ✓* | ✓* | Wishlist belongs to the caller |
| `GET /uploads/video-jobs/:jobId`, `GET /uploads/scans/:fileId` | — | ✓* | ✓* | ✓* | ✓* | User/job ownership is checked by the upload service |

## Instructor and administrator endpoints

For owner-bound operations, an instructor may act only on their own course or
resource. An instructor-other is denied; an administrator is allowed where
listed.

| Endpoint(s) | Anonymous | Student | Instructor-owner | Instructor-other | Admin | Ownership / condition |
|---|---:|---:|---:|---:|---:|---|
| `POST /assignments`, `POST /assignments/submissions/:id/review`, `GET /assignments/instructor/pending` | — | — | ✓* | — | ✓ | Instructor owns the lesson/course; admin override |
| `POST /coupons`, `GET /coupons`, `GET /coupons/:id`, `PATCH /coupons/:id`, `DELETE /coupons/:id`, `GET /coupons/:id/redemptions` | — | — | ✓* | — | ✓ | Instructors manage coupons they created and may scope them only to courses they own; only admins may manage platform-wide coupons |
| `POST /backups/courses/:courseId/export`, `GET /backups/courses/:courseId/versions`, `GET /backups/courses/:courseId/versions/:version`, `GET /backups/courses/export/:backupId/status`, `GET /backups/courses/export/:backupId/download`, `GET /backups/courses/export/list` | — | — | ✓* | — | ✓ | Instructor may access own course backups; admin override |
| `POST /courses/autosave`, `GET /courses/autosave/recovered`, `GET /courses/autosave/:id`, `DELETE /courses/autosave/:id` | — | — | ✓* | — | ✓ | Drafts are owned by the authenticated instructor |
| `POST /courses`, `PATCH /courses/:id`, `PATCH /courses/:id/status`, `PUT /courses/:id/prerequisites`, `DELETE /courses/:id/prerequisites/:prerequisiteId`, `GET /courses/:id/students`, `POST /courses/:id/announcements` | — | — | ✓* | — | ✓ | Course owner or admin |
| `POST /courses/:id/submit` | — | — | ✓* | — | — | Instructor-only submission for own course |
| `GET /courses/admin/pending`, `POST /courses/:id/approve`, `POST /courses/:id/reject` | — | — | — | — | ✓ | Admin review actions |
| `POST /bundles` | — | — | ✓* | — | ✓ | Instructor creates a bundle as its owner |
| `POST /exams`, `DELETE /exams/:id` | — | — | ✓* | — | ✓ | Instructor owns the associated course/exam; admin override |
| `POST /lessons/modules`, `POST /lessons`, `PATCH /lessons/modules/:moduleId`, `DELETE /lessons/modules/:moduleId`, `PATCH /lessons/courses/:courseId/reorder`, `PATCH /lessons/:id`, `DELETE /lessons/:id`, `PATCH /lessons/:id/thumbnail`, `POST /lessons/courses/:courseId/drip-schedule`, `PATCH /lessons/:id/drip-schedule`, `POST /lessons/enrollments/:enrollmentId/drip-override` | — | — | ✓* | — | ✓ | Instructor must own the course; admin override |
| `POST /quizzes/lessons/:lessonId/questions`, `PATCH /quizzes/questions/:id`, `DELETE /quizzes/questions/:id`, `PATCH /quizzes/lessons/:lessonId/questions/reorder` | — | — | ✓* | — | ✓ | Instructor owns the course/lesson; admin override |
| `POST /uploads/course-asset`, `POST /uploads/lesson-video` | — | — | ✓* | — | ✓ | Controller verifies course ownership; admin override |
| `POST /kyc/submit`, `GET /kyc/my`, `GET /kyc/my/status` | — | — | ✓* | — | — | Instructor's own KYC submissions |
| `GET /reports/engagement` | — | — | ✓* | — | ✓ | Instructor report is scoped to own courses; admin may query across courses |

## Administrator-only endpoints

| Endpoint(s) | Anonymous | Student | Instructor-owner | Instructor-other | Admin | Ownership / condition |
|---|---:|---:|---:|---:|---:|---|
| `GET /admin/dashboard/summary`, `POST /admin/impersonation/start`, `GET /admin/impersonation/audit-logs`, `GET /admin/impersonation/sessions/:sessionId`, `POST /admin/impersonation/sessions/:sessionId/stop` | — | — | — | — | ✓ | Admin role required |
| `GET /analytics/volume`, `GET /analytics/events`, `GET /analytics/events/export` | — | — | — | — | ✓ | Admin role required |
| `GET /audit-log`, `GET /audit-log/export`, `POST /backups/courses/scheduled/run`, `POST /backups/enrollments/restore`, `GET /backups/enrollments/restore/reports`, `GET /backups/enrollments/restore/reports/:id`, `POST /backups/courses/restore`, `GET /backups/courses/restore/jobs`, `GET /backups/courses/restore/jobs/:id`, `POST /backups/courses/restore/jobs/:id/run` | — | — | — | — | ✓ | Admin role required |
| `POST /badges/catalog`, `POST /badges/catalog/seed`, `PATCH /badges/catalog/:id`, `POST /badges/students/:studentId/milestones` | — | — | — | — | ✓ | Admin role required |
| `GET /admin/tax-rates`, `PUT /admin/tax-rates/:region`, `DELETE /admin/tax-rates/:region` | — | — | — | — | ✓ | Admin role required |
| `POST /certificate-templates`, `GET /certificate-templates`, `GET /certificate-templates/active/:category`, `GET /certificate-templates/:id`, `PATCH /certificate-templates/:id`, `DELETE /certificate-templates/:id`, `POST /certificate-templates/:id/preview`, `POST /certificate-templates/:id/activate`, `POST /certificate-templates/:id/deactivate` | — | — | — | — | ✓ | Admin role required |
| `POST /certificates`, `GET /certificates/:id/admin`, `PATCH /certificates/:id/tx-hash`, `POST /certificates/:id/revoke` | — | — | — | — | ✓ | Admin role required |
| `GET /discussions/moderation/flagged`, `GET /discussions/moderation/summary`, `PATCH /discussions/comments/:id/review`, `GET /moderation/dashboard`, `PATCH /moderation/flags/:id/resolve`, `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/review`, `POST /disputes/:id/resolve` | — | — | — | — | ✓ | Admin role required |
| `GET /enrollments/admin`, `GET /refunds`, `POST /refunds/:id/approve`, `POST /refunds/:id/reject`, `POST /refunds/:id/process` | — | — | — | — | ✓ | Admin role required |
| `GET /enrollments/fraud/queue`, `GET /enrollments/fraud/student/:studentId`, `GET /enrollments/fraud/:flagId`, `POST /enrollments/fraud/:flagId/review` | — | — | — | — | ✓ | Admin role required |
| `GET /events`, `GET /events/dead-lettered`, `POST /events/:id/retry`, `GET /cron-monitor/runs`, `GET /cron-monitor/stats`, `GET /cron-monitor/stale`, `POST /cron-monitor/stale/mark-failed`, `GET /cron-monitor/runs/:id` | — | — | — | — | ✓ | Admin role required |
| `POST /feature-flags`, `GET /feature-flags`, `GET /feature-flags/:key`, `PATCH /feature-flags/:key`, `DELETE /feature-flags/:key`, `POST /feature-flags/:key/enable`, `POST /feature-flags/:key/disable`, `POST /gamification/leaderboard/recalculate` | — | — | — | — | ✓ | Admin role required |
| `GET /kyc`, `GET /kyc/:id`, `POST /kyc/:id/review`, `POST /kyc/:id/revoke` | — | — | — | — | ✓ | Admin role required |
| `POST /learning-paths`, `PATCH /learning-paths/:id`, `DELETE /learning-paths/:id`, `PUT /learning-paths/:id/courses`, `POST /learning-paths/:id/publish`, `POST /learning-paths/:id/unpublish` | — | — | — | — | ✓ | Admin role required |
| `GET /notifications/sms/:id/status`, `POST /notifications/sms/send`, `POST /privacy/data-exports/cleanup` | — | — | — | — | ✓ | Admin role required; SMS callbacks are separately signature-verified |
| `POST /payouts`, `PATCH /payouts/:id/status` | — | — | — | — | ✓ | Admin role required |
| `GET /referrals/rules`, `PATCH /referrals/rules`, `GET /reports/admin`, `GET /reports/admin/top-targets`, `GET /reports/admin/target/:targetType/:targetId/count`, `GET /reports/admin/:id`, `PATCH /reports/admin/:id/status` | — | — | — | — | ✓ | Admin role required |
| `GET /reports/instructors/:instructorId/performance`, `GET /reports/revenue`, `GET /reports/top-courses`, `POST /search/reindex` | — | — | — | — | ✓ | Admin role required |
| `DELETE /courses/:courseId/reviews/:reviewId` | — | — | — | — | ✓ | Admin moderation action |
| `POST /tags`, `PATCH /tags/:id`, `DELETE /tags/:id`, `POST /tags/:id/merge`, `POST /tags/:id/attach`, `DELETE /tags/:id/detach/:courseId` | — | — | — | — | ✓ | Admin role required |
| `POST /cdn/invalidate`, `GET /cdn/invalidations`, `GET /cdn/invalidations/:id`, `POST /cdn/validate-signed-url`, `POST /cdn/resolve` | — | — | — | — | ✓ | Admin role required |
| `POST /users/:userId/ban`, `POST /users/:userId/unban`, `POST /users/:userId/suspend`, `POST /users/:userId/unsuspend`, `GET /users/:userId/account-status` | — | — | — | — | ✓ | Admin moderation action |

## Role-restricted endpoints available to all authenticated roles

| Endpoint(s) | Anonymous | Student | Instructor-owner | Instructor-other | Admin | Ownership / condition |
|---|---:|---:|---:|---:|---:|---|
| `GET /learning-paths`, `GET /learning-paths/:id`, `GET /learning-paths/:id/progress` | — | ✓* | ✓* | ✓* | ✓* | Progress and enrollment details are user-scoped |
| `GET /tags`, `GET /tags/course/:courseId`, `GET /tags/:id` | — | ✓ | ✓ | ✓ | ✓ | JWT and RolesGuard require one of the three defined roles |

## Role and ownership source

The matrix reflects controller decorators and explicit controller checks in
`src/modules/**/**.controller.ts` and `src/common/queue/queue.controller.ts`.
The shared role guard reads method metadata before controller metadata; an
endpoint with no role metadata is not role-restricted. See
[roles.guard.ts](../src/common/guards/roles.guard.ts),
[jwt-auth.guard.ts](../src/common/guards/jwt-auth.guard.ts),
[optional-jwt-auth.guard.ts](../src/common/guards/optional-jwt-auth.guard.ts),
and [app.module.ts](../src/app.module.ts) for the shared guard setup.

Ownership checks are enforced in the relevant service/controller paths, not by
`@Roles` alone. In particular, course, lesson, quiz, exam, backup, upload,
autosave, payout, invoice, and user-data routes must continue to pass the
authenticated user identity to the service when changing or reading an
owner-bound record. Recheck this matrix whenever a controller route, guard,
role decorator, or ownership check changes.
