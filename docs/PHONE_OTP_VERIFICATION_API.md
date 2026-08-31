# Phone OTP Verification API

## Overview

This API provides phone number verification via SMS one-time passcodes (OTP) using Africa's Talking gateway.

## Features

- Generate and send 6-digit OTP via SMS
- Track OTP expiry (10 minutes)
- Track verification attempts (max 5 per OTP)
- Rate limiting (3 requests per minute per phone number)
- Update user profile with verified phone status
- Automatic invalidation of previous unused OTPs

## Endpoints

### 1. Send OTP

**POST** `/api/v1/otp/send`

Send a verification code to a phone number.

#### Authentication
Requires JWT authentication (Bearer token).

#### Request Body

```json
{
  "phoneNumber": "+254712345678",
  "countryCode": "KE"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| phoneNumber | string | Yes | Phone number in E.164 format (e.g., +254712345678) |
| countryCode | string | Yes | ISO 3166-1 alpha-2 country code (2-3 characters) |

#### Response (200 OK)

```json
{
  "message": "OTP sent successfully. Please check your phone."
}
```

#### Error Responses

**429 Too Many Requests**
```json
{
  "statusCode": 429,
  "message": "Too many OTP requests. Please try again in 45 seconds.",
  "error": "Too Many Requests"
}
```

**400 Bad Request**
```json
{
  "statusCode": 400,
  "message": "Failed to send OTP. Please try again.",
  "error": "Bad Request"
}
```

---

### 2. Verify OTP

**POST** `/api/v1/otp/verify`

Verify the OTP code received via SMS.

#### Authentication
Requires JWT authentication (Bearer token).

#### Request Body

```json
{
  "phoneNumber": "+254712345678",
  "otp": "123456"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| phoneNumber | string | Yes | Phone number in E.164 format |
| otp | string | Yes | 6-digit OTP code received via SMS |

#### Response (200 OK)

```json
{
  "message": "Phone number verified successfully",
  "verified": true
}
```

#### Error Responses

**401 Unauthorized - No OTP Found**
```json
{
  "statusCode": 401,
  "message": "No valid OTP found. Please request a new one.",
  "error": "Unauthorized"
}
```

**401 Unauthorized - Expired OTP**
```json
{
  "statusCode": 401,
  "message": "OTP has expired. Please request a new one.",
  "error": "Unauthorized"
}
```

**401 Unauthorized - Invalid OTP**
```json
{
  "statusCode": 401,
  "message": "Invalid OTP. 4 attempts remaining.",
  "error": "Unauthorized"
}
```

**401 Unauthorized - Max Attempts Exceeded**
```json
{
  "statusCode": 401,
  "message": "Maximum verification attempts exceeded. Please request a new OTP.",
  "error": "Unauthorized"
}
```

---

### 3. Get Verification Status

**GET** `/api/v1/otp/status`

Get the phone verification status for the current authenticated user.

#### Authentication
Requires JWT authentication (Bearer token).

#### Response (200 OK)

```json
{
  "isPhoneVerified": true,
  "phoneNumber": "+254712345678",
  "phoneVerifiedAt": "2026-08-27T12:30:45.123Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| isPhoneVerified | boolean | Whether phone is verified |
| phoneNumber | string \| null | Verified phone number or null |
| phoneVerifiedAt | string \| null | ISO 8601 timestamp of verification or null |

---

## Configuration

### Environment Variables

```bash
# Africa's Talking credentials
AFRICASTALKING_USERNAME=sandbox
AFRICASTALKING_API_KEY=your-api-key
AFRICASTALKING_SENDER_ID=Hamplard
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| OTP_EXPIRY_MINUTES | 10 | OTP validity duration |
| OTP_MAX_ATTEMPTS | 5 | Maximum verification attempts per OTP |
| OTP_RATE_LIMIT_WINDOW_MS | 60000 | Rate limit window (1 minute) |
| OTP_RATE_LIMIT_MAX_REQUESTS | 3 | Max requests per window |

---

## Usage Flow

```
1. User requests OTP
   POST /api/v1/otp/send
   { "phoneNumber": "+254712345678", "countryCode": "KE" }
   
2. System generates 6-digit OTP
   - Invalidates previous unused OTPs
   - Creates new OTP record (expires in 10 min)
   - Sends SMS via Africa's Talking
   
3. User receives SMS with OTP
   "Your Hamplard verification code is: 123456. Valid for 10 minutes."
   
4. User submits OTP for verification
   POST /api/v1/otp/verify
   { "phoneNumber": "+254712345678", "otp": "123456" }
   
5. System validates OTP
   - Checks expiry
   - Checks attempt count
   - Verifies code matches
   - Updates user profile (isPhoneVerified = true)
   
6. User profile updated
   GET /api/v1/otp/status
   Returns verified status
```

---

## Rate Limiting

### Per Phone Number
- **Window**: 60 seconds
- **Max Requests**: 3 OTP sends per window
- **Reset**: Automatic after 60 seconds

### Behavior
When rate limit is exceeded:
- HTTP 429 status returned
- Error message includes seconds until retry
- Window resets automatically

---

## Security Features

1. **Single-use OTPs**: Previous unused OTPs are invalidated when new one is requested
2. **Expiry**: OTPs expire after 10 minutes
3. **Attempt limiting**: Max 5 verification attempts per OTP
4. **Rate limiting**: Prevents SMS bombing (3 requests/minute)
5. **Authenticated endpoints**: All endpoints require valid JWT
6. **E.164 validation**: Phone numbers must be in international format

---

## Database Schema

### PhoneOtp Table

```sql
CREATE TABLE "phone_otp" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "attemptCount" INTEGER DEFAULT 0,
    "expiresAt" TIMESTAMP NOT NULL,
    "verifiedAt" TIMESTAMP,
    "isUsed" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
```

### User Table Updates

```sql
ALTER TABLE "users" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "users" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "users" ADD COLUMN "isPhoneVerified" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN "phoneVerifiedAt" TIMESTAMP;
```

---

## Testing

Run unit tests:
```bash
npm test src/modules/auth/otp.service.spec.ts
```

## Development Mode

In development (`NODE_ENV=development`), OTP codes are logged to console when SMS client is not configured.

---

## Error Handling

All endpoints return consistent error format:

```json
{
  "statusCode": 400|401|429,
  "message": "Human-readable error message",
  "error": "Error type"
}
```
