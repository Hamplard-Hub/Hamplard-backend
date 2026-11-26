# 2FA Recovery Codes Regeneration - Issue #355

## Overview

Users can now regenerate their 2FA recovery codes without having to disable and re-enable 2FA. This is useful when:
- Recovery codes have been used and running low
- Recovery codes may have been compromised
- Recovery codes were lost but authenticator app is still available
- User wants to rotate codes as a security best practice

## Endpoint

```http
POST /api/v1/auth/2fa/recovery-codes
Authorization: Bearer {token}
Content-Type: application/json

{
  "code": "123456"
}
```

**Authentication**: Required (JWT token)  
**Roles**: ADMIN, INSTRUCTOR (any role with 2FA enabled)  
**2FA Requirement**: User must have 2FA already enabled  

## Request

### Headers

```
Authorization: Bearer {jwt-token}
Content-Type: application/json
```

### Body

```json
{
  "code": "123456"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Current TOTP code from authenticator app (6 digits) |

**Important**: Only TOTP codes from the authenticator app are accepted. Recovery codes cannot be used to regenerate recovery codes (security measure).

## Response

### Success (200 OK)

```json
{
  "recoveryCodes": [
    "A1B2C-D3E4F",
    "G5H6I-J7K8L",
    "M9N0O-P1Q2R",
    "S3T4U-V5W6X",
    "Y7Z8A-B9C0D",
    "E1F2G-H3I4J",
    "K5L6M-N7O8P",
    "Q9R0S-T1U2V",
    "W3X4Y-Z5A6B",
    "C7D8E-F9G0H"
  ]
}
```

**Important**: 
- Save these codes immediately in a secure location
- Old recovery codes are **immediately invalidated**
- These codes are single-use
- Each code can only be used once at login

### Error Responses

#### 400 Bad Request - Validation Error

```json
{
  "statusCode": 400,
  "message": [
    "code must be longer than or equal to 6 characters",
    "code must be a string"
  ],
  "error": "Bad Request"
}
```

**Causes:**
- Missing `code` field
- Code is not a string
- Code is not exactly 6 characters

#### 400 Bad Request - 2FA Not Enabled

```json
{
  "statusCode": 400,
  "message": "Two-factor authentication is not enabled for this account",
  "error": "Bad Request"
}
```

**Cause**: User attempting to regenerate codes without having 2FA enabled first.

**Solution**: User must enable 2FA before they can regenerate recovery codes.

#### 401 Unauthorized - Invalid TOTP Code

```json
{
  "statusCode": 401,
  "message": "Invalid two-factor authentication code",
  "error": "Unauthorized"
}
```

**Causes:**
- Incorrect TOTP code entered
- Code has expired (codes expire every 30 seconds)
- Recovery code was provided instead of TOTP code
- Device time is not synchronized

**Solutions:**
- Wait for the next code (30-second interval)
- Check device time synchronization
- Ensure using TOTP code from authenticator app, not a recovery code

#### 404 Not Found - User Not Found

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```

**Cause**: User ID from JWT token does not exist in database.

## Usage Examples

### cURL

```bash
curl -X POST https://api.example.com/api/v1/auth/2fa/recovery-codes \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

### JavaScript/TypeScript

```typescript
async function regenerateRecoveryCodes(accessToken: string, totpCode: string) {
  const response = await fetch('https://api.example.com/api/v1/auth/2fa/recovery-codes', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code: totpCode }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }

  const data = await response.json();
  return data.recoveryCodes;
}

// Usage
try {
  const codes = await regenerateRecoveryCodes(userToken, '123456');
  console.log('New recovery codes:', codes);
  // Display codes to user and prompt to save them
} catch (error) {
  console.error('Failed to regenerate codes:', error.message);
}
```

### Python

```python
import requests

def regenerate_recovery_codes(access_token, totp_code):
    response = requests.post(
        'https://api.example.com/api/v1/auth/2fa/recovery-codes',
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json',
        },
        json={'code': totp_code}
    )
    
    if response.status_code == 200:
        return response.json()['recoveryCodes']
    else:
        raise Exception(f"Failed: {response.json()['message']}")

# Usage
codes = regenerate_recovery_codes(user_token, '123456')
print(f"New recovery codes: {codes}")
```

## Security Considerations

### Why TOTP Only?

The endpoint requires a TOTP code from the authenticator app, **not** a recovery code. This is intentional:

1. **Proof of possession**: Requires the authenticator app, proving the user still has access to their 2FA device
2. **Prevents abuse**: Recovery codes could theoretically be stolen or guessed; TOTP codes rotate every 30 seconds
3. **Security best practice**: Similar to how disabling 2FA requires confirmation

### Old Codes Immediately Invalidated

When new codes are generated:
- ✅ All old recovery codes are immediately invalidated
- ✅ Old codes cannot be used for future logins
- ✅ No grace period or overlap
- ✅ Database is updated atomically

This prevents:
- Race conditions where both old and new codes work
- Security vulnerabilities if old codes were compromised

### Storage

Recovery codes are:
- ✅ **Hashed** using SHA-256 before storage
- ✅ **Never stored in plain text** in the database
- ✅ **Single-use** (removed from database after use)
- ✅ **Generated cryptographically** using `crypto.randomBytes()`

## User Workflow

### Complete Flow

1. **User realizes they need new recovery codes**
   - Used several codes
   - Codes may be compromised
   - Lost codes but still have authenticator app
   - Rotating codes as security practice

2. **User opens authenticator app**
   - Gets current 6-digit TOTP code
   - Codes rotate every 30 seconds

3. **User calls regenerate endpoint**
   ```http
   POST /api/v1/auth/2fa/recovery-codes
   Body: { "code": "123456" }
   ```

4. **System validates TOTP code**
   - Checks if 2FA is enabled
   - Verifies TOTP code is correct
   - Rejects recovery codes

5. **System generates new codes**
   - Generates 10 new random codes
   - Hashes codes using SHA-256
   - Stores hashed codes in database
   - **Immediately invalidates old codes**

6. **System returns plain codes**
   ```json
   {
     "recoveryCodes": ["A1B2C-D3E4F", ...]
   }
   ```

7. **User saves new codes**
   - Downloads as file
   - Copies to password manager
   - Prints and stores physically
   - **Important**: This is the only time codes are shown

## Frontend Implementation Tips

### Display Recovery Codes

```typescript
function RecoveryCodesDisplay({ codes }: { codes: string[] }) {
  return (
    <div className="recovery-codes">
      <h3>⚠️ Save These Recovery Codes</h3>
      <p>Store them in a safe place. Each code can only be used once.</p>
      
      <div className="codes-grid">
        {codes.map((code, index) => (
          <div key={index} className="code-item">
            <span className="code-number">{index + 1}.</span>
            <code>{code}</code>
          </div>
        ))}
      </div>
      
      <div className="actions">
        <button onClick={() => downloadCodes(codes)}>
          Download as Text File
        </button>
        <button onClick={() => copyToClipboard(codes.join('\n'))}>
          Copy to Clipboard
        </button>
        <button onClick={() => window.print()}>
          Print Codes
        </button>
      </div>
      
      <p className="warning">
        ⚠️ Old recovery codes have been invalidated and will no longer work.
      </p>
    </div>
  );
}
```

### Download Codes as File

```typescript
function downloadCodes(codes: string[]) {
  const content = `
Two-Factor Authentication Recovery Codes
Generated: ${new Date().toISOString()}

IMPORTANT: Store these codes in a safe place.
Each code can only be used once.

${codes.map((code, i) => `${i + 1}. ${code}`).join('\n')}

---
These codes can be used to log in if you lose access to your authenticator app.
  `.trim();

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recovery-codes-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
```

### Regeneration Modal

```typescript
function RegenerateCodesModal({ isOpen, onClose }: Props) {
  const [totpCode, setTotpCode] = useState('');
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegenerate = async () => {
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch('/api/v1/auth/2fa/recovery-codes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: totpCode }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message);
      }

      const data = await response.json();
      setNewCodes(data.recoveryCodes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (newCodes) {
    return <RecoveryCodesDisplay codes={newCodes} />;
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <h2>Regenerate Recovery Codes</h2>
      
      <p>
        Enter your current 6-digit code from your authenticator app.
        Your old recovery codes will be immediately invalidated.
      </p>
      
      <input
        type="text"
        maxLength={6}
        pattern="[0-9]{6}"
        value={totpCode}
        onChange={(e) => setTotpCode(e.target.value)}
        placeholder="000000"
      />
      
      {error && <p className="error">{error}</p>}
      
      <button 
        onClick={handleRegenerate}
        disabled={totpCode.length !== 6 || loading}
      >
        {loading ? 'Regenerating...' : 'Regenerate Codes'}
      </button>
    </Modal>
  );
}
```

## Testing

### Unit Tests

Located in `src/modules/auth/two-factor-recovery.spec.ts`:

```bash
npm test -- two-factor-recovery.spec.ts
```

**Test coverage:**
- ✅ Regenerate codes with valid TOTP
- ✅ Reject when user not found
- ✅ Reject when 2FA not enabled
- ✅ Reject when TOTP code invalid
- ✅ Reject recovery codes (must use TOTP)
- ✅ Generate exactly 10 codes
- ✅ Replace old codes with new ones
- ✅ Hash codes before storing
- ✅ Log successful regeneration
- ✅ Old codes don't work after regeneration

### Integration Tests

Located in `src/modules/auth/two-factor-recovery-integration.spec.ts`:

```bash
npm test -- two-factor-recovery-integration.spec.ts
```

**Test coverage:**
- ✅ POST endpoint with valid code
- ✅ Validation errors
- ✅ Authentication required
- ✅ Role-based access
- ✅ Recovery codes format

### Manual Testing

1. **Setup 2FA** (if not already enabled):
   ```bash
   POST /api/v1/auth/2fa/setup
   POST /api/v1/auth/2fa/enable
   ```

2. **Regenerate codes**:
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/2fa/recovery-codes \
     -H "Authorization: Bearer {token}" \
     -H "Content-Type: application/json" \
     -d '{"code":"123456"}'
   ```

3. **Verify old codes don't work**:
   - Try logging in with an old recovery code
   - Should fail with "Invalid two-factor authentication code"

4. **Verify new codes work**:
   - Try logging in with a new recovery code
   - Should succeed

## Comparison: Old vs New Process

### Before (Issue #355)

To get new recovery codes:

1. Disable 2FA (requires TOTP or recovery code)
2. Re-enable 2FA (setup + scan QR code)
3. Get new recovery codes

**Problems:**
- Cumbersome multi-step process
- Requires re-scanning QR code
- Brief window without 2FA protection
- Risk of misconfiguration

### After (Issue #355)

To get new recovery codes:

1. Call regenerate endpoint with TOTP code
2. Get new recovery codes immediately

**Benefits:**
- ✅ Single API call
- ✅ No need to re-scan QR code
- ✅ 2FA remains enabled throughout
- ✅ Immediate invalidation of old codes
- ✅ User-friendly

## Troubleshooting

### "Invalid two-factor authentication code"

**Cause**: TOTP code is incorrect or expired.

**Solutions:**
1. Wait for next code (30-second cycle)
2. Check device time synchronization:
   - iOS: Settings → General → Date & Time → Set Automatically
   - Android: Settings → System → Date & Time → Set Automatically
3. Ensure using TOTP code, not recovery code

### "Two-factor authentication is not enabled"

**Cause**: User hasn't enabled 2FA yet.

**Solution**: Enable 2FA first:
```bash
POST /api/v1/auth/2fa/setup
POST /api/v1/auth/2fa/enable
```

### Old recovery code still works

**Cause**: This should never happen if the endpoint was called successfully.

**Debug steps:**
1. Check database: `SELECT "twoFactorRecoveryCodes" FROM users WHERE id = 'user-id';`
2. Verify codes were updated
3. Check application logs for regeneration confirmation

**Mitigation**: Call regenerate endpoint again to force update.

### Can't use recovery code to regenerate

**Cause**: By design — only TOTP codes are accepted.

**Reason**: Security measure to ensure user has access to authenticator app.

**Solution**: Use TOTP code from authenticator app instead.

## Best Practices

### For Users

1. **Regenerate codes periodically** (every 6-12 months)
2. **Store codes securely**:
   - Password manager (recommended)
   - Encrypted file
   - Physical copy in secure location
3. **Regenerate after compromise**:
   - If you suspect codes were stolen
   - After using multiple codes
   - When device security is questioned
4. **Keep authenticator app backed up**:
   - Use app with cloud backup (Authy)
   - Or manually backup secret during setup

### For Developers

1. **Prompt users to save codes**: Show clear warning before closing modal
2. **Confirm regeneration**: Ask user to confirm before invalidating old codes
3. **Show remaining codes**: Display count of unused recovery codes
4. **Suggest regeneration**: Prompt when codes are running low (e.g., < 3 left)
5. **Log regeneration events**: Track when users regenerate codes for security audit

## Related Documentation

- [2FA Setup Flow](./2FA_SETUP.md)
- [Admin 2FA Requirement](./ADMIN_2FA_REQUIREMENT.md)
- [2FA Login Flow](./2FA_LOGIN.md)
