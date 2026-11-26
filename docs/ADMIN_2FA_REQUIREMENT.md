# Admin Two-Factor Authentication Requirement - Issue #354

## Overview

As of this implementation, **two-factor authentication (2FA) is required for all admin accounts** before they can access admin endpoints. This prevents admins from performing sensitive operations (impersonation, refunds, payouts, user management) without the additional security of 2FA.

## Motivation

Admins have elevated privileges including:
- User impersonation
- Processing refunds and payouts
- Access to KYC documents
- Moderation actions
- System configuration changes

Without 2FA enforcement, a compromised admin account could cause significant damage. This requirement ensures that even if an admin's password is compromised, attackers cannot access admin functions without also having access to the admin's 2FA device.

## Configuration

### Environment Variable

```env
# Default: true (enforced)
REQUIRE_ADMIN_2FA=true
```

**Recommended**: Keep this `true` in production. Only set to `false` for local development or testing if necessary.

### Behavior

| Setting | Behavior |
|---------|----------|
| `REQUIRE_ADMIN_2FA=true` (default) | Admin users must have 2FA enabled to access protected endpoints |
| `REQUIRE_ADMIN_2FA=false` | 2FA is optional for admins (not recommended for production) |

## How It Works

### Admin2faGuard

A new guard (`Admin2faGuard`) has been added to the authentication flow:

1. **Applied globally to protected endpoints** via controller decorators
2. **Checks only admin users** - instructors and students are unaffected
3. **Allows grace setup flow** - endpoints marked with `@SkipAdmin2faCheck()` are exempt
4. **Rejects with 403** - Admins without 2FA get a clear error message with setup instructions

### Guard Flow

```
Request → JwtAuthGuard → RolesGuard → Admin2faGuard → Endpoint
           ↓                ↓            ↓
        Validate JWT    Check Role    Check Admin 2FA
```

## Admin Setup Flow

When an admin user logs in without 2FA enabled, they can only access the 2FA setup endpoints:

### Step 1: Check Status

```http
GET /api/v1/auth/2fa/status
Authorization: Bearer {admin-token}
```

Response:
```json
{
  "enabled": false,
  "enabledAt": null
}
```

### Step 2: Generate Secret

```http
POST /api/v1/auth/2fa/setup
Authorization: Bearer {admin-token}
```

Response:
```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/Hamplard%20(admin@example.com)?secret=JBSWY3DPEHPK3PXP&issuer=Hamplard",
  "qrCodeDataUrl": "data:image/png;base64,..."
}
```

**Action**: Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.)

### Step 3: Enable 2FA

```http
POST /api/v1/auth/2fa/enable
Authorization: Bearer {admin-token}
Content-Type: application/json

{
  "code": "123456"
}
```

Response:
```json
{
  "enabled": true,
  "recoveryCodes": [
    "A1B2C-D3E4F",
    "G5H6I-J7K8L",
    ...
  ]
}
```

**Important**: Save the recovery codes in a secure location!

### Step 4: Access Admin Endpoints

After 2FA is enabled, the admin can access all admin endpoints normally.

## Exempt Endpoints

The following endpoints are marked with `@SkipAdmin2faCheck()` to allow the setup flow:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/2fa/status` | GET | Check if 2FA is enabled |
| `/auth/2fa/setup` | POST | Generate TOTP secret |
| `/auth/2fa/enable` | POST | Complete 2FA setup |

**Note**: The `/auth/2fa/disable` endpoint is **NOT** exempt — admins must have 2FA enabled to disable it (requires current TOTP code for confirmation).

## Protected Endpoints

All admin endpoints are protected by default. When an admin without 2FA attempts to access them:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "statusCode": 403,
  "message": "Two-factor authentication is required for admin accounts. Please enable 2FA at POST /api/v1/auth/2fa/setup and POST /api/v1/auth/2fa/enable before accessing admin endpoints.",
  "error": "Forbidden"
}
```

## Login Flow with 2FA

When an admin with 2FA enabled logs in, they must provide their TOTP code:

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "stellarAddress": "GXXX...",
  "signature": "...",
  "timestamp": 1234567890,
  "totpCode": "123456"
}
```

Or with Google login:

```http
POST /api/v1/auth/google/login
Content-Type: application/json

{
  "idToken": "...",
  "totpCode": "123456"
}
```

If the TOTP code is missing or invalid, login is rejected with 401 Unauthorized.

## Impact on Existing Admins

### Scenario 1: Existing Admin Without 2FA

1. Admin logs in successfully
2. Admin tries to access any admin endpoint
3. Receives 403 error with setup instructions
4. Admin follows setup flow (above)
5. Admin can now access all endpoints

### Scenario 2: Existing Admin With 2FA

No impact — admins who already have 2FA enabled continue to work as before.

## Disabling 2FA Requirement (Not Recommended)

If you need to temporarily disable the 2FA requirement (e.g., for local development):

```env
REQUIRE_ADMIN_2FA=false
```

**Warning**: This should only be used in development. Never disable this in production.

## Instructor Accounts

Instructors are **not affected** by this requirement. 2FA remains optional for instructors and students.

If you want to require 2FA for instructors as well, you can:
1. Modify the `Admin2faGuard` to check for `UserRole.INSTRUCTOR`
2. Add similar grace setup flow handling

## Recovery Scenarios

### Lost 2FA Device

1. Admin uses a recovery code instead of TOTP code at login
2. Recovery codes are single-use
3. Admin should immediately:
   - Disable 2FA (using another recovery code)
   - Re-enable 2FA with a new device
   - Save new recovery codes

### Locked Out Admin

If an admin is completely locked out (lost device + no recovery codes):

**Manual intervention required**:

```sql
-- Connect to database
UPDATE users 
SET 
  "twoFactorEnabled" = false,
  "twoFactorSecret" = NULL,
  "twoFactorRecoveryCodes" = ARRAY[]::text[],
  "twoFactorEnabledAt" = NULL
WHERE id = 'admin-user-id';
```

After reset:
1. Admin logs in normally
2. Admin must immediately re-enable 2FA
3. Consider implementing a backup admin contact process

## Testing

### Unit Tests

```bash
# Test the Admin2faGuard
npm test -- admin-2fa.guard.spec

# Test the TwoFactorController integration
npm test -- two-factor.controller.spec
```

### Manual Testing

1. **Create a test admin user**:
```sql
INSERT INTO users (id, email, name, role, "stellarAddress")
VALUES ('test-admin', 'admin@test.com', 'Test Admin', 'ADMIN', 'GTEST...');
```

2. **Login as admin** (without 2FA)

3. **Try to access admin endpoint**:
```bash
curl -H "Authorization: Bearer {token}" \
  http://localhost:3000/api/v1/admin/users
```

Expected: 403 Forbidden

4. **Enable 2FA** (follow setup flow above)

5. **Try again**:
```bash
curl -H "Authorization: Bearer {token}" \
  http://localhost:3000/api/v1/admin/users
```

Expected: 200 OK with user list

## Security Considerations

### Benefits

✅ **Defense in depth** - Additional layer beyond password  
✅ **Phishing resistance** - Time-based codes expire quickly  
✅ **Audit trail** - 2FA enablement is logged with timestamp  
✅ **Recovery codes** - Secure backup access method  
✅ **Brute-force protection** - Per-account lockout on failed attempts  

### Limitations

⚠️ **SIM swapping** - SMS-based 2FA (not used here) is vulnerable  
⚠️ **Malware** - Compromised device can bypass 2FA  
⚠️ **Social engineering** - Users must keep recovery codes secure  

### Best Practices

1. **Use authenticator apps** (Google Authenticator, Authy, 1Password) instead of SMS
2. **Store recovery codes securely** (password manager, encrypted backup)
3. **Rotate recovery codes** periodically by disabling/re-enabling 2FA
4. **Monitor admin logins** for suspicious activity
5. **Enforce strong passwords** in addition to 2FA
6. **Use hardware tokens** (YubiKey) for highest security (future enhancement)

## Compliance

This implementation helps meet security requirements for:
- **SOC 2** - Access control and authentication policies
- **PCI DSS** - Multi-factor authentication for administrative access
- **GDPR** - Security measures for personal data access
- **ISO 27001** - Information security controls

## Future Enhancements

Potential improvements to consider:

1. **Hardware token support** (WebAuthn/FIDO2)
2. **Backup admin codes** (time-limited codes generated by super-admin)
3. **2FA audit log** (track when 2FA is enabled/disabled)
4. **Email notifications** when 2FA status changes
5. **Grace period** (X days warning before enforcement)
6. **Role-based 2FA** (require for instructors above certain threshold)
7. **Biometric authentication** support

## Troubleshooting

### "Invalid two-factor authentication code" on login

- Check device time synchronization (TOTP codes are time-based)
- Ensure you're using the latest code (they expire every 30 seconds)
- Try using a recovery code instead

### "Too many failed two-factor attempts" error

- Wait 15 minutes (default lockout period)
- Use a recovery code to bypass lockout
- Check Redis connection for rate limiting

### Admin can't access endpoints after enabling 2FA

- Verify `twoFactorEnabled=true` in database
- Check if `REQUIRE_ADMIN_2FA=true` in environment
- Ensure admin role is correctly set
- Try logging out and back in

### Setup endpoint returns 403

- This endpoint should be exempt with `@SkipAdmin2faCheck()`
- Verify the decorator is present in `two-factor.controller.ts`
- Check that `Admin2faGuard` properly checks for the metadata

## References

- [RFC 6238 - TOTP: Time-Based One-Time Password Algorithm](https://tools.ietf.org/html/rfc6238)
- [OWASP - Multi-Factor Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [NIST SP 800-63B - Digital Identity Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
