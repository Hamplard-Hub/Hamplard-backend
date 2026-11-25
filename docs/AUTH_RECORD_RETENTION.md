# Authentication record retention

The `auth-record-purge` cron runs daily at **00:00 UTC**. Set
`AUTH_RECORD_RETENTION_DAYS` to a positive integer (default **30**).
Invalid settings fail the monitored job before any deletion.

- Sessions and refresh tokens are deleted when either `expiresAt` or
  `revokedAt` is strictly older than the retention cutoff.
- Phone OTPs are deleted only when `expiresAt` is strictly older than the cutoff.
- Active records, recent expiry/revocation, and records exactly at the cutoff
  remain. Creation, last activity, token consumption, and OTP verification do
  not themselves qualify a record for deletion.

Each run uses one cutoff and a PostgreSQL transaction-scoped advisory lock.
Overlapping runs in other API instances skip deletion; the lock is released
automatically when the transaction ends. All three deletes roll back together
on failure, and the transaction times out after 60 seconds. The cron monitor
records success/failure; application logs contain deletion counts, never token
or OTP contents. Re-running the job is idempotent.

Apply the auth-retention indexes migration with the normal deployment migration
process. If a first purge exceeds the transaction timeout on a large backlog,
schedule an operational backfill before relying on the daily job; it will retry
on the next day without partial deletion.

## Verification

```sh
npm test -- --runInBand auth-cleanup.service.spec.ts
npm run build
npm test -- --runInBand
```

The optional PostgreSQL regression suite uses **only a disposable test database**:
set `AUTH_PURGE_TEST_DATABASE_URL` to that database, initialize it from the Prisma
schema, then run `npm test -- --runInBand auth-cleanup.integration.spec.ts`.
The cleanup intentionally scans all authentication rows in that test database;
never point this test setting at a development or production database with data
you need to retain. Without the explicit URL, this integration suite is skipped.
