# Admin 2FA Quick Reference

## Configuration

```env
# Enable admin 2FA requirement (default: true)
REQUIRE_ADMIN_2FA=true
```

## Setup Flow (3 Steps)

### 1. Generate Secret

```bash
POST /api/v1/auth/2fa/setup
Authorization: Bearer {admin-token}
```

Response includes QR code to scan with authenticator app.

### 2. Enable 2FA

```bash
POST /api/v1/auth/2fa/enable
Authorization: Bearer {admin-token}
Content-Type: application/json

{
  "code": "123456"
}
```

**Save the recovery codes!**

### 3. Done

Admin can now access all endpoints.

## Error When 2FA Required

```json
HTTP/1.1 403 Forbidden

{
  "statusCode": 403,
  "message": "Two-factor authentication is required for admin accounts. Please enable 2FA at POST /api/v1/auth/2fa/setup and POST /api/v1/auth/2fa/enable before accessing admin endpoints."
}
```

## Applying to Controllers

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Admin2faGuard, SkipAdmin2faCheck } from '../../common/guards/admin-2fa.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('admin/my-feature')
@UseGuards(JwtAuthGuard, RolesGuard, Admin2faGuard)
@Roles(UserRole.ADMIN)
export class MyAdminController {
  
  // Protected: Requires 2FA
  @Get('sensitive')
  sensitiveAction() {
    return { message: 'Requires 2FA' };
  }
  
  // Exempt: Does not require 2FA
  @Get('public')
  @SkipAdmin2faCheck()
  publicAction() {
    return { message: 'No 2FA needed' };
  }
}
```

## Guard Behavior

| User Role | 2FA Status | Endpoint | Access |
|-----------|-----------|----------|--------|
| ADMIN | ❌ No | Regular | ❌ Blocked (403) |
| ADMIN | ❌ No | With `@SkipAdmin2faCheck()` | ✅ Allowed |
| ADMIN | ✅ Yes | Any | ✅ Allowed |
| INSTRUCTOR | Any | Any | ✅ Allowed |
| STUDENT | Any | Any | ✅ Allowed |

## Exempt Endpoints

These endpoints **do not** require 2FA (allow grace setup):

- `GET /api/v1/auth/2fa/status`
- `POST /api/v1/auth/2fa/setup`
- `POST /api/v1/auth/2fa/enable`

## Protected Endpoints

These endpoints **require** 2FA:

- `POST /api/v1/auth/2fa/disable` (must have 2FA to disable it)
- All `/admin/*` endpoints
- Any endpoint with `@Roles(UserRole.ADMIN)` and no `@SkipAdmin2faCheck()`

## Database Queries

### Check 2FA Adoption

```sql
SELECT 
  COUNT(*) FILTER (WHERE role = 'ADMIN') as total_admins,
  COUNT(*) FILTER (WHERE role = 'ADMIN' AND "twoFactorEnabled" = true) as with_2fa
FROM users;
```

### List Admins Without 2FA

```sql
SELECT id, email, name 
FROM users 
WHERE role = 'ADMIN' 
  AND "twoFactorEnabled" = false
  AND "deletedAt" IS NULL;
```

### Emergency: Disable 2FA for Locked Admin

```sql
UPDATE users 
SET 
  "twoFactorEnabled" = false,
  "twoFactorSecret" = NULL,
  "twoFactorRecoveryCodes" = ARRAY[]::text[],
  "twoFactorEnabledAt" = NULL
WHERE id = 'admin-user-id';
```

## Testing

### Unit Tests

```bash
npm test -- admin-2fa.guard.spec.ts
npm test -- two-factor.controller.spec.ts
```

### Manual Test

```bash
# 1. Login as admin without 2FA
# 2. Try admin endpoint (should fail)
curl -H "Authorization: Bearer {token}" \
  http://localhost:3000/api/v1/admin/users

# Expected: 403 Forbidden

# 3. Setup 2FA (follow 3-step flow above)

# 4. Try again (should succeed)
curl -H "Authorization: Bearer {token}" \
  http://localhost:3000/api/v1/admin/users

# Expected: 200 OK
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Invalid code" | Check device time sync |
| Locked out | Use recovery code or wait 15 min |
| Lost device | Use recovery code, then re-setup |
| Lost recovery codes | Manual DB reset (see SQL above) |
| Setup returns 403 | Check `@SkipAdmin2faCheck()` decorator |

## Rollback

**Immediate**: Set `REQUIRE_ADMIN_2FA=false` and restart.

```bash
# Docker
docker-compose restart api

# PM2
pm2 restart hamplard-api

# Kubernetes
kubectl rollout restart deployment/hamplard-api
```

## Login with 2FA

After enabling 2FA, login requires TOTP code:

```bash
# Stellar login
POST /api/v1/auth/login
{
  "stellarAddress": "G...",
  "signature": "...",
  "timestamp": 123,
  "totpCode": "123456"
}

# Google login
POST /api/v1/auth/google/login
{
  "idToken": "...",
  "totpCode": "123456"
}
```

## Recovery Codes

- 10 codes generated when enabling 2FA
- Single-use (removed after use)
- Use instead of TOTP code at login
- Save securely (password manager, encrypted backup)
- Regenerate by disabling and re-enabling 2FA

## Monitoring

Application logs:

```
[Admin2faGuard] Admin 2FA enforcement is ENABLED
[Admin2faGuard] Admin user {id} attempted to access protected endpoint without 2FA enabled
[TwoFactorService] User {id} locked out after {count} failed two-factor attempts
```

## Resources

- [Full Documentation](./ADMIN_2FA_REQUIREMENT.md)
- [Migration Guide](./ADMIN_2FA_MIGRATION_GUIDE.md)
- [Architecture Diagram](#) (see implementation artifact)
