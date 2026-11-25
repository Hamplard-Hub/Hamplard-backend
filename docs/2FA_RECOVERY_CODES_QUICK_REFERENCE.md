# 2FA Recovery Codes Quick Reference

## Regenerate Recovery Codes

### Endpoint

```http
POST /api/v1/auth/2fa/recovery-codes
Authorization: Bearer {token}
Content-Type: application/json

{
  "code": "123456"
}
```

**Response:**
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

## Quick Facts

| Feature | Detail |
|---------|--------|
| Authentication | Required (JWT) |
| Roles | ADMIN, INSTRUCTOR (any with 2FA) |
| Prerequisite | 2FA must be enabled |
| Code Type | TOTP only (not recovery code) |
| New Codes | 10 codes generated |
| Old Codes | Immediately invalidated |
| Storage | SHA-256 hashed |
| Format | `XXXXX-XXXXX` (5-5 alphanumeric) |

## cURL Example

```bash
curl -X POST https://api.example.com/api/v1/auth/2fa/recovery-codes \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

## TypeScript Example

```typescript
async function regenerateCodes(totpCode: string) {
  const response = await fetch('/api/v1/auth/2fa/recovery-codes', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code: totpCode }),
  });
  
  const { recoveryCodes } = await response.json();
  return recoveryCodes;
}
```

## Common Errors

| Error | Code | Cause | Solution |
|-------|------|-------|----------|
| Validation | 400 | Missing/invalid code | Provide 6-digit string |
| Not Enabled | 400 | 2FA not enabled | Enable 2FA first |
| Invalid Code | 401 | Wrong TOTP | Wait for next code |
| Not Found | 404 | User doesn't exist | Check JWT token |

## Security Notes

✅ **TOTP only** - Recovery codes cannot regenerate codes  
✅ **Immediate invalidation** - Old codes stop working instantly  
✅ **Hashed storage** - Codes never stored in plain text  
✅ **Single-use** - Each code works only once  
✅ **Logged** - Regeneration events are logged  

## User Workflow

1. Open authenticator app
2. Get current 6-digit TOTP code
3. Call endpoint with code
4. Receive 10 new recovery codes
5. **Save codes immediately!**
6. Old codes are now invalid

## Testing

```bash
# Unit tests
npm test -- two-factor-recovery.spec.ts

# Integration tests
npm test -- two-factor-recovery-integration.spec.ts
```

## Troubleshooting

### Invalid TOTP Code
- Wait for next code (30 sec)
- Check time sync on device
- Ensure using TOTP, not recovery code

### 2FA Not Enabled
- Enable 2FA first:
  ```
  POST /auth/2fa/setup
  POST /auth/2fa/enable
  ```

### Old Code Still Works
- Should never happen
- Call regenerate again if needed
- Check database for code hashes

## Related Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /auth/2fa/status` | Check if 2FA enabled |
| `POST /auth/2fa/setup` | Generate TOTP secret |
| `POST /auth/2fa/enable` | Enable 2FA (get initial codes) |
| `POST /auth/2fa/disable` | Disable 2FA |
| `POST /auth/2fa/recovery-codes` | **Regenerate codes** |

## Best Practices

**For Users:**
- Save codes in password manager
- Regenerate every 6-12 months
- Regenerate after using multiple codes
- Keep authenticator app backed up

**For Developers:**
- Prompt user to save codes
- Show remaining codes count
- Suggest regeneration when low (< 3)
- Allow download/print options
- Confirm before regenerating

## Full Documentation

See [2FA_RECOVERY_CODES_REGENERATION.md](./2FA_RECOVERY_CODES_REGENERATION.md) for complete documentation.
