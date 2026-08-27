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
