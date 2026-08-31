# User Ban & Suspend API Documentation

## Overview

This feature allows administrators to ban or suspend user accounts in the Hamplard platform. Banned users are permanently blocked from accessing the platform, while suspended users are temporarily restricted until a specified date.

## Database Changes

### New User Model Fields

```prisma
model User {
  // ... existing fields
  
  // Ban fields
  isBanned       Boolean   @default(false)
  bannedAt       DateTime?
  banReason      String?
  
  // Suspension fields
  isSuspended    Boolean   @default(false)
  suspendedAt    DateTime?
  suspendedUntil DateTime?
  suspensionReason String?
}
```

### New Audit Actions

Two new audit actions were added to track user management:
- `USER_SUSPENDED` - When a user is suspended
- `USER_UNSUSPENDED` - When a suspension is lifted

## API Endpoints

All endpoints require admin authorization (`@Roles(UserRole.ADMIN)`).

### 1. Ban User

**POST** `/users/:userId/ban`

Permanently bans a user account.

**Request Body:**
```json
{
  "reason": "Violation of community guidelines - repeated harassment",
  "notes": "User was warned 3 times before ban (optional)"
}
```

**Response:**
```json
{
  "id": "user-uuid",
  "stellarAddress": "GABC...",
  "isBanned": true,
  "bannedAt": "2026-07-30T12:00:00Z",
  "banReason": "Violation of community guidelines",
  // ... other user fields
}
```

**Validations:**
- User must exist
- User must not already be banned
- Cannot ban admin users
- Clears any existing suspension when banned

---

### 2. Unban User

**POST** `/users/:userId/unban`

Removes the ban from a user account.

**Request Body:**
```json
{
  "reason": "Appeal successful, user has acknowledged community guidelines (optional)"
}
```

**Response:**
```json
{
  "id": "user-uuid",
  "isBanned": false,
  "bannedAt": null,
  "banReason": null,
  // ... other user fields
}
```

**Validations:**
- User must exist
- User must be currently banned

---

### 3. Suspend User

**POST** `/users/:userId/suspend`

Temporarily suspends a user account until a specified date.

**Request Body:**
```json
{
  "reason": "Temporary suspension pending investigation",
  "suspendedUntil": "2026-08-15T00:00:00Z",
  "notes": "User appealed, case under review (optional)"
}
```

**Response:**
```json
{
  "id": "user-uuid",
  "isSuspended": true,
  "suspendedAt": "2026-07-30T12:00:00Z",
  "suspendedUntil": "2026-08-15T00:00:00Z",
  "suspensionReason": "Temporary suspension pending investigation",
  // ... other user fields
}
```

**Validations:**
- User must exist
- User must not be banned (unban first)
- User must not already be suspended
- Cannot suspend admin users
- `suspendedUntil` must be in the future

---

### 4. Unsuspend User

**POST** `/users/:userId/unsuspend`

Lifts a suspension from a user account early.

**Request Body:**
```json
{
  "reason": "Investigation concluded, no violation found (optional)"
}
```

**Response:**
```json
{
  "id": "user-uuid",
  "isSuspended": false,
  "suspendedAt": null,
  "suspendedUntil": null,
  "suspensionReason": null,
  // ... other user fields
}
```

**Validations:**
- User must exist
- User must be currently suspended

---

### 5. Check Account Status

**GET** `/users/:userId/account-status`

Checks the ban/suspend status of a user account.

**Response:**
```json
{
  "isActive": false,
  "isBanned": true,
  "banReason": "Violation of terms",
  "bannedAt": "2026-07-30T12:00:00Z",
  "isSuspended": false,
  "suspensionReason": null,
  "suspendedAt": null,
  "suspendedUntil": null
}
```

**Features:**
- Automatically unsuspends if `suspendedUntil` date has passed
- Returns comprehensive status information

---

## Authentication Guard Integration

### JWT Auth Guard Enhancement

The `JwtAuthGuard` has been enhanced to automatically check user account status on every authenticated request:

1. **Ban Check**: If user is banned, throws `UnauthorizedException` with ban reason
2. **Suspension Check**: If user is suspended:
   - Checks if suspension has expired
   - Auto-unsuspends if expired
   - Throws `UnauthorizedException` if still suspended
3. **Session Revocation**: Banned/suspended users cannot use their JWT tokens

**Error Messages:**

```javascript
// Banned user
{
  "statusCode": 401,
  "message": "Account is permanently banned. Reason: Violation of terms"
}

// Suspended user
{
  "statusCode": 401,
  "message": "Account is suspended until 2026-08-15T00:00:00.000Z. Reason: Under review"
}
```

---

## Audit Logging

All ban/suspend actions are automatically logged to the `AdminAuditLog` table with:

- **actorId**: Admin who performed the action
- **action**: `USER_BANNED`, `USER_UNBANNED`, `USER_SUSPENDED`, `USER_UNSUSPENDED`
- **targetType**: `USER`
- **targetId**: User ID affected
- **metadata**: Detailed information including:
  - Reason for action
  - User email, name, stellar address
  - Previous ban/suspension details (for unban/unsuspend)
  - Suspension duration (for suspend)
- **ipAddress**: IP address of the admin

Example audit log entry:

```json
{
  "id": "audit-uuid",
  "actorId": "admin-uuid",
  "action": "USER_BANNED",
  "targetType": "USER",
  "targetId": "user-uuid",
  "metadata": {
    "reason": "Repeated harassment",
    "userEmail": "user@example.com",
    "userName": "John Doe",
    "stellarAddress": "GABC..."
  },
  "ipAddress": "192.168.1.1",
  "createdAt": "2026-07-30T12:00:00Z"
}
```

---

## Usage Examples

### Example 1: Ban a user for policy violation

```bash
curl -X POST https://api.hamplard.com/users/USER_ID/ban \
  -H "Authorization: Bearer ADMIN_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Violation of community guidelines - spam",
    "notes": "User posted promotional content 5 times after warnings"
  }'
```

### Example 2: Suspend user pending investigation

```bash
curl -X POST https://api.hamplard.com/users/USER_ID/suspend \
  -H "Authorization: Bearer ADMIN_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Under investigation for copyright violation",
    "suspendedUntil": "2026-08-15T00:00:00Z"
  }'
```

### Example 3: Check if a user can access the platform

```bash
curl -X GET https://api.hamplard.com/users/USER_ID/account-status \
  -H "Authorization: Bearer ADMIN_JWT_TOKEN"
```

---

## Security Features

1. **Admin-Only Access**: All endpoints require `ADMIN` role
2. **Admin Protection**: Cannot ban or suspend other admin users
3. **Automatic Session Revocation**: JWT tokens are checked on every request
4. **IP Tracking**: All admin actions are logged with IP address
5. **Comprehensive Audit Trail**: All actions are logged with full context
6. **Auto-Unsuspend**: Expired suspensions are automatically lifted

---

## Error Handling

| Error Code | Scenario |
|------------|----------|
| `404 Not Found` | User does not exist |
| `400 Bad Request` | User already banned/suspended, invalid suspension date |
| `403 Forbidden` | Attempting to ban/suspend an admin user |
| `401 Unauthorized` | Banned/suspended user tries to use their token |

---

## Testing Checklist

- [ ] Ban a user successfully
- [ ] Verify banned user cannot authenticate
- [ ] Unban a user successfully
- [ ] Verify unbanned user can authenticate again
- [ ] Suspend a user with future date
- [ ] Verify suspended user cannot authenticate
- [ ] Unsuspend a user early
- [ ] Verify suspension auto-expires after date
- [ ] Attempt to ban an admin user (should fail)
- [ ] Attempt to suspend an admin user (should fail)
- [ ] Verify audit logs are created for all actions
- [ ] Check account status endpoint returns correct data

---

## Migration Instructions

1. **Run the migration:**
   ```bash
   npx prisma migrate deploy
   ```

2. **Generate Prisma Client:**
   ```bash
   npx prisma generate
   ```

3. **Restart the application:**
   ```bash
   npm run start:dev
   ```

---

## Future Enhancements

Potential improvements for future iterations:

1. **Email Notifications**: Send email to banned/suspended users
2. **Appeal System**: Allow users to submit ban/suspension appeals
3. **Temporary Bans**: Add support for temporary bans with auto-unban
4. **Ban History**: Track multiple ban/unban cycles
5. **Bulk Actions**: Ban/suspend multiple users at once
6. **Scheduled Suspensions**: Schedule suspensions to start at a future date
7. **Custom Ban Pages**: Show custom messages to banned users
8. **Webhook Notifications**: Notify external systems of ban/suspend events

# TODO — Webhook HMAC Signature Verification

Implement a complete HMAC-based webhook signing system for outgoing webhook requests. The purpose of this feature is to allow webhook subscribers to independently verify that a request was generated by our backend and that the webhook payload has not been modified before reaching the subscriber.

## 1. Implement Webhook Signer Service

* Create or complete `backend/src/modules/webhooks/webhook-signer.service.ts`.
* Use Node.js `crypto` and NestJS `@nestjs/common`.
* Use HMAC-SHA256 as the signing algorithm unless an existing project standard requires another secure algorithm.
* Generate the signature from the exact webhook payload that will be transmitted.
* Ensure payload serialization is deterministic so subscribers can reproduce the signature.
* Return signatures in a documented and consistent format, for example `sha256=<hex_signature>`.
* Keep all cryptographic operations inside the signer service rather than duplicating signing logic across controllers or dispatch handlers.

## 2. Track Subscriber Signing Secrets

* Add support for a unique signing secret for each webhook subscriber.
* Associate every secret with the correct subscriber or webhook endpoint.
* Generate secrets using cryptographically secure random data.
* Prevent secrets from appearing in normal API responses, logs, exceptions, debugging output, or webhook delivery logs.
* Ensure only authorized internal operations can create, retrieve, update, or rotate signing secrets.
* Follow existing project conventions for persistence, encryption, configuration, and database access.

## 3. Support Secret Rotation

* Implement secret rotation without interrupting webhook delivery.
* A subscriber should be able to receive requests signed with the newly generated secret immediately after rotation.
* During a configurable transition period, the previous secret should remain available for verification where required.
* Clearly identify which secret is currently active for signing.
* Ensure old secrets can be disabled or removed after the transition period.
* Handle simultaneous webhook deliveries safely while a secret is being rotated.

## 4. Validate Signature Format

* Validate the generated signature before sending the webhook request.
* Confirm the algorithm prefix and encoded signature follow the expected format.
* Reject malformed, empty, incomplete, or unexpectedly long signatures.
* Handle missing subscriber secrets gracefully.
* Do not expose the actual signing secret or sensitive cryptographic details in errors.

## 5. Add Signature Header

* Add the generated signature to every applicable outgoing webhook request.
* Use a dedicated header such as `X-Webhook-Signature`.
* Ensure the header is included consistently for all webhook deliveries.
* Make sure the signature is generated from the exact payload placed in the request body.
* Document the header format so subscribers know how to verify incoming requests.

## 6. Integrate With Dispatch

* Integrate signing directly into the existing webhook dispatch flow.
* Generate the signature immediately before the HTTP request is sent.
* Ensure retries continue to use the correct signing secret and payload.
* Prevent unsigned requests from being dispatched when signing is required.
* Ensure signing failures are handled safely and do not result in partially constructed webhook requests.

## 7. Add Tests

* Test successful signature generation.
* Test known payload/secret combinations.
* Test signature format validation.
* Test signature header inclusion.
* Test missing and invalid secrets.
* Test payload tampering detection.
* Test secret rotation and transition periods.
* Test concurrent webhook delivery during rotation.
* Test retry behavior.
* Test secure signature comparison using constant-time comparison where verification is performed.

## Final Acceptance Check

Confirm that signing occurs during dispatch, every subscriber has a managed secret, signature formatting is validated, rotation works without downtime, and every outgoing signed webhook contains the correct `X-Webhook-Signature` header.
# TODO — Webhook Signature Verification Middleware

Implement a secure HMAC-based webhook signing system for outgoing webhook requests. The goal is to allow webhook subscribers to verify that requests originated from our backend and that the payload was not modified in transit.

## 1. Webhook Signing Service

* Create or complete `backend/src/modules/webhooks/webhook-signer.service.ts`.
* Use Node.js `crypto` to generate HMAC signatures.
* Define a consistent signing algorithm, preferably HMAC-SHA256.
* Sign the exact serialized webhook payload that will be sent to the subscriber.
* Ensure the same payload bytes are used for signing and transmission to prevent verification mismatches.
* Return the generated signature in a predictable format, such as `sha256=<signature>`.

## 2. Subscriber Signing Secrets

* Add support for storing a unique signing secret for every webhook subscriber.
* Never store secrets in plaintext if the existing architecture supports secure secret handling.
* Ensure secrets are generated using cryptographically secure randomness.
* Associate each secret with the correct subscriber/webhook endpoint.
* Prevent secrets from being exposed in API responses, logs, errors, or application output.

## 3. Secret Rotation

* Support rotating a subscriber's signing secret without interrupting webhook delivery.
* During rotation, allow the previous secret to remain valid for a defined transition period.
* New webhook requests should use the newest active secret.
* Remove or deactivate the previous secret once the rotation period expires.
* Ensure concurrent webhook deliveries do not fail because a secret is being rotated.

## 4. Signature Validation

* Validate the generated signature format before sending the request.
* Reject malformed or unexpectedly formatted signatures.
* Use a constant-time comparison mechanism such as `crypto.timingSafeEqual` when comparing signatures.
* Handle missing secrets, invalid signatures, and unexpected crypto errors safely.
* Avoid leaking sensitive information through validation errors or logs.

## 5. Webhook Request Header

* Add the generated signature to every outgoing webhook request.
* Use a dedicated header such as `X-Webhook-Signature`.
* Keep the header format consistent across all webhook deliveries.
* Ensure the signature corresponds exactly to the payload being transmitted.

## 6. Dispatch Integration

* Integrate signing into the existing webhook dispatch flow.
* Signing must happen immediately before the request is sent.
* Make sure every applicable outgoing webhook is signed.
* Ensure retries sign the payload correctly and behave consistently with the configured secret.

## 7. Tests

Add unit/integration tests covering:

* Successful HMAC signature generation.
* Correct signature for a known payload and secret.
* Signature format validation.
* Signature header inclusion.
* Missing or invalid secrets.
* Tampered payload detection.
* Secret rotation with old/new secret handling.
* Concurrent delivery during secret rotation.
* Retry behavior.
* Timing-safe signature comparison.

## Acceptance Check

Confirm that signing is performed during dispatch, secrets are tracked per subscriber, signatures are validated before sending, secret rotation works without downtime, and every signed webhook request contains the expected signature header.
