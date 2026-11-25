# Admin 2FA Migration Guide

## Overview

This guide helps you roll out the admin 2FA requirement to existing deployments with minimal disruption.

## Pre-Deployment Checklist

- [ ] Review the [Admin 2FA Requirement documentation](./ADMIN_2FA_REQUIREMENT.md)
- [ ] Identify all admin users in your database
- [ ] Notify admins of upcoming 2FA requirement
- [ ] Prepare support documentation for your team
- [ ] Test in staging environment first
- [ ] Plan rollout window (low-traffic time recommended)

## Deployment Strategies

### Strategy 1: Immediate Enforcement (Recommended for Small Teams)

**Best for**: Small teams (1-5 admins) where you can coordinate directly

1. **Before deployment**: Notify all admins they will need to set up 2FA immediately after deployment
2. **Deploy** with `REQUIRE_ADMIN_2FA=true`
3. **Each admin**:
   - Logs in
   - Receives 403 on first admin action
   - Follows setup flow in error message
   - Completes 2FA setup
   - Resumes normal work

**Downside**: Brief interruption for each admin

### Strategy 2: Grace Period (Recommended for Large Teams)

**Best for**: Large teams where coordinating simultaneous setup is difficult

1. **Deploy** with `REQUIRE_ADMIN_2FA=false`
2. **Notify admins**: 2FA will be required starting {date}
3. **Encourage early adoption**:
   - Send setup guides
   - Offer support sessions
   - Track adoption rate
4. **Monitor adoption**:
   ```sql
   SELECT 
     COUNT(*) FILTER (WHERE role = 'ADMIN') as total_admins,
     COUNT(*) FILTER (WHERE role = 'ADMIN' AND "twoFactorEnabled" = true) as admins_with_2fa,
     ROUND(100.0 * COUNT(*) FILTER (WHERE role = 'ADMIN' AND "twoFactorEnabled" = true) / 
           COUNT(*) FILTER (WHERE role = 'ADMIN'), 2) as adoption_rate
   FROM users;
   ```
5. **Enable enforcement**: Set `REQUIRE_ADMIN_2FA=true` once adoption is high
6. **Handle stragglers**: Contact admins without 2FA directly

**Downside**: Requires monitoring and follow-up

### Strategy 3: Gradual Rollout with Feature Flag

**Best for**: Very large teams or high-stakes environments

1. **Deploy** with `REQUIRE_ADMIN_2FA=false`
2. **Create a feature flag** to enable per-admin:
   ```sql
   ALTER TABLE users ADD COLUMN "require2FA" BOOLEAN DEFAULT false;
   ```
3. **Modify guard** to check user-specific flag
4. **Enable for pilot group**
5. **Gather feedback and iterate**
6. **Gradually roll out** to more admins
7. **Enable globally** once validated

**Downside**: Requires additional implementation work

## Communication Templates

### Email to Admins (1 Week Before)

```
Subject: Important: Two-Factor Authentication Required for Admin Accounts

Hi [Admin Name],

Starting [Date], two-factor authentication (2FA) will be required for all admin accounts on [Platform Name].

What this means for you:
- After [Date], you'll need to set up 2FA to access admin functions
- Setup takes about 2 minutes
- You'll need an authenticator app (Google Authenticator, Authy, 1Password, etc.)

How to set up 2FA:
1. Download an authenticator app if you don't have one
2. Log in to [Platform Name]
3. Try to access any admin page
4. Follow the setup instructions in the error message
5. Save your recovery codes securely

Why we're doing this:
Admin accounts have elevated privileges. 2FA adds an extra layer of security to protect user data and platform operations.

Need help? Reply to this email or join our support session on [Date/Time].

Thanks,
[Your Team]
```

### Slack/Teams Announcement

```
📢 Admin 2FA Requirement - Action Required

Starting [Date], 2FA will be required for admin accounts.

✅ What to do:
1. Install authenticator app (Google Authenticator recommended)
2. Log in and visit any admin page
3. Follow setup flow (~2 mins)
4. Save recovery codes!

📚 Documentation: [Link]
❓ Questions: #admin-support
⏰ Support session: [Date/Time] - [Meeting Link]
```

### Setup Guide (Send After Deployment)

```
Quick Setup Guide: Admin 2FA

Step 1: Get an Authenticator App
- Google Authenticator (iOS/Android)
- Authy (iOS/Android/Desktop)
- 1Password (if you use it already)
- Microsoft Authenticator

Step 2: Enable 2FA
1. Log in to [Platform]
2. Try to access any admin page (e.g., User Management)
3. You'll see: "Two-factor authentication is required..."
4. Click the link or go to: [Base URL]/api/v1/auth/2fa/setup
5. Scan the QR code with your authenticator app
6. Enter the 6-digit code from your app
7. SAVE YOUR RECOVERY CODES SECURELY

Step 3: Done!
You can now access all admin functions. You'll be asked for a 2FA code each time you log in.

Troubleshooting:
- "Invalid code" error: Check your device's time sync
- Lost device: Use one of your recovery codes
- Lost recovery codes: Contact [Admin Contact] for manual reset

Questions? Reply to this message or join #admin-support
```

## Database Queries

### Check Current 2FA Adoption

```sql
-- Overall stats
SELECT 
  role,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE "twoFactorEnabled" = true) as with_2fa,
  ROUND(100.0 * COUNT(*) FILTER (WHERE "twoFactorEnabled" = true) / COUNT(*), 2) as adoption_percent
FROM users
WHERE role IN ('ADMIN', 'INSTRUCTOR')
GROUP BY role;
```

### List Admins Without 2FA

```sql
-- Admins who need to set up 2FA
SELECT 
  id,
  email,
  name,
  "createdAt",
  "lastLoginAt"
FROM users
WHERE role = 'ADMIN'
  AND "twoFactorEnabled" = false
  AND "deletedAt" IS NULL
ORDER BY "lastLoginAt" DESC NULLS LAST;
```

### Force Disable 2FA (Emergency Only)

```sql
-- Emergency: Disable 2FA for locked-out admin
UPDATE users 
SET 
  "twoFactorEnabled" = false,
  "twoFactorSecret" = NULL,
  "twoFactorRecoveryCodes" = ARRAY[]::text[],
  "twoFactorEnabledAt" = NULL
WHERE id = 'admin-user-id';

-- After this, admin must re-enable 2FA immediately
```

## Monitoring

### Metrics to Track

1. **Adoption Rate**:
   ```sql
   SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE "twoFactorEnabled" = true) / COUNT(*), 2)
   FROM users WHERE role = 'ADMIN';
   ```

2. **Failed 2FA Attempts**:
   - Monitor Redis keys: `auth:2fa:failed:*`
   - Alert on high failure rates

3. **Admin Lockouts**:
   - Monitor Redis keys: `auth:2fa:lockout:*`
   - Track admins who get locked out

4. **Support Requests**:
   - Track 2FA-related tickets
   - Identify common issues

### Application Logs

Watch for these log messages:

```
Admin 2FA enforcement is ENABLED
Admin user {id} attempted to access protected endpoint without 2FA enabled
User {id} locked out after {count} failed two-factor attempts
```

## Rollback Plan

If you encounter critical issues:

### Immediate Rollback (< 5 minutes)

1. **Set environment variable**:
   ```bash
   REQUIRE_ADMIN_2FA=false
   ```

2. **Restart application**:
   ```bash
   # Docker
   docker-compose restart api
   
   # PM2
   pm2 restart hamplard-api
   
   # Kubernetes
   kubectl rollout restart deployment/hamplard-api
   ```

3. **Verify**:
   ```bash
   curl -H "Authorization: Bearer {admin-token}" \
     https://api.yourdomain.com/api/v1/admin/users
   ```

### Permanent Rollback (If Needed)

If you need to completely remove the 2FA requirement:

1. Set `REQUIRE_ADMIN_2FA=false`
2. Document reason for rollback
3. Plan remediation:
   - Fix identified issues
   - Re-test in staging
   - Re-plan rollout

**Note**: Admins who already enabled 2FA will still need to provide codes at login. To disable individual 2FA:

```sql
UPDATE users 
SET "twoFactorEnabled" = false 
WHERE id = 'user-id';
```

## Common Issues and Solutions

### Issue: Admin Can't Scan QR Code

**Solution**: Provide manual entry option
```
Secret: JBSWY3DPEHPK3PXP
Type: Time-based
Digits: 6
Period: 30 seconds
```

### Issue: "Invalid code" on First Try

**Solutions**:
1. Check device time sync:
   - iOS: Settings → General → Date & Time → Set Automatically
   - Android: Settings → System → Date & Time → Set Automatically
2. Wait for next code (codes expire every 30 seconds)
3. Ensure no typos (use copy-paste if available)

### Issue: Admin Loses Device Before Saving Recovery Codes

**Solution**: 
1. Manual database reset (see SQL above)
2. Admin re-enables 2FA
3. Admin saves recovery codes this time

**Prevention**: Email recovery codes automatically (future enhancement)

### Issue: Authenticator App Shows Wrong Platform

**Cause**: Admin scanned QR code from wrong tab/session

**Solution**:
1. Delete incorrect entry from authenticator app
2. Generate new secret: POST /api/v1/auth/2fa/setup
3. Scan new QR code

## Testing in Staging

Before deploying to production:

1. **Create test admin**:
   ```sql
   INSERT INTO users (id, email, name, role, "stellarAddress")
   VALUES ('test-admin', 'admin@test.local', 'Test Admin', 'ADMIN', 'GTEST...');
   ```

2. **Test without 2FA**:
   - Log in as test admin
   - Try to access admin endpoint
   - Verify 403 response

3. **Test setup flow**:
   - Call POST /api/v1/auth/2fa/setup
   - Scan QR code
   - Call POST /api/v1/auth/2fa/enable
   - Verify success

4. **Test with 2FA**:
   - Log out and back in with TOTP code
   - Access admin endpoints
   - Verify 200 response

5. **Test lockout**:
   - Enter wrong codes 5 times
   - Verify lockout error
   - Wait 15 minutes or use recovery code

6. **Test recovery codes**:
   - Log in with recovery code instead of TOTP
   - Verify one-time use (code should be removed)

7. **Test disable**:
   - Call POST /api/v1/auth/2fa/disable
   - Verify 2FA is disabled

## Support Plan

### Support Resources Needed

1. **Documentation**:
   - Setup guide (see above)
   - Troubleshooting guide
   - FAQ document

2. **Support Team**:
   - Train on 2FA concepts
   - Provide scripts for common issues
   - Define escalation path

3. **Admin Access**:
   - Identify who can perform manual resets
   - Create secure process for identity verification

### Expected Support Volume

Based on typical 2FA rollouts:
- **Week 1**: High (setup questions, basic troubleshooting)
- **Week 2**: Medium (lost devices, recovery codes)
- **Week 3+**: Low (occasional lockouts, device changes)

## Success Criteria

Deployment is successful when:

- [ ] All active admins have 2FA enabled
- [ ] No admins are locked out without recovery
- [ ] Support tickets return to baseline
- [ ] No critical operations blocked
- [ ] Audit logs show successful 2FA logins
- [ ] Security monitoring shows no anomalies

## Post-Deployment

### Week 1
- Monitor adoption metrics daily
- Respond quickly to support requests
- Document any issues and workarounds

### Week 2
- Review and address common issues
- Update documentation based on feedback
- Plan improvements (if needed)

### Month 1
- Audit admin 2FA compliance
- Review security logs for suspicious activity
- Plan regular 2FA recovery code rotation

### Ongoing
- Include 2FA in admin onboarding
- Regular reminders to rotate recovery codes
- Monitor for failed login attempts
- Plan hardware token rollout (future)

## Questions?

Contact your security team or open an issue in the project repository.
