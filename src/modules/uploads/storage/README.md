# Storage Drivers

This module provides a pluggable storage interface for file uploads with implementations for local disk and S3-compatible object storage.

## Overview

The storage layer abstracts file operations (write, read, existence checks, etc.) behind a common `StorageDriver` interface, allowing the application to switch between local disk and S3-compatible storage through configuration.

## Architecture

```
storage/
├── storage.interface.ts    # StorageDriver interface definition
├── local.storage.ts        # Local disk implementation
├── s3.storage.ts          # S3-compatible implementation
├── storage.factory.ts     # Factory for creating driver instances
├── storage.spec.ts        # Unit tests
└── index.ts               # Barrel exports
```

## Storage Drivers

### Local Storage (`local`)

**Default driver.** Stores files on the local filesystem.

- Files are written to the directory specified by `UPLOAD_DIR` (default: `./uploads`)
- Synchronous methods are provided for backward compatibility
- Files are served through the API (no direct public URLs)
- Not suitable for multi-instance deployments (files are instance-local)

### S3 Storage (`s3`)

Stores files in S3-compatible object storage (AWS S3, MinIO, DigitalOcean Spaces, etc.).

**Features:**
- Streaming uploads (non-blocking)
- Private/public bucket separation (KYC → private, everything else → public)
- Pre-signed URL generation for secure access
- CDN integration support
- Compatible with any S3-compatible service

**Bucket Strategy:**
- **Private bucket** (`S3_BUCKET`): KYC documents, certificates, sensitive data
- **Public bucket** (`S3_PUBLIC_BUCKET`): Course thumbnails, lessons, public resources

## Configuration

### Local Storage (Default)

```env
STORAGE_DRIVER=local
UPLOAD_DIR=./uploads
```

### S3 Storage

#### AWS S3

```env
STORAGE_DRIVER=s3
S3_BUCKET=hamplard-private-uploads
S3_PUBLIC_BUCKET=hamplard-public-uploads
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=us-east-1
```

#### MinIO / DigitalOcean Spaces

```env
STORAGE_DRIVER=s3
S3_BUCKET=hamplard-private
S3_PUBLIC_BUCKET=hamplard-public
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
# Custom endpoint for S3-compatible services
S3_ENDPOINT=https://sfo3.digitaloceanspaces.com
S3_FORCE_PATH_STYLE=true
# Optional: CDN for public files
S3_CDN_URL=https://cdn.hamplard.com
```

## Usage

### In Services

The storage driver is injected via the `STORAGE_DRIVER` token:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { StorageDriver, STORAGE_DRIVER } from './storage';

@Injectable()
export class UploadsService {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  async saveFile(buffer: Buffer, path: string): Promise<void> {
    await this.storage.writeFile(path, buffer);
  }

  async readFile(path: string): Promise<Buffer | null> {
    return await this.storage.readFile(path);
  }
}
```

### Storage Driver Interface

```typescript
interface StorageDriver {
  // Write a file to storage
  writeFile(relativePath: string, buffer: Buffer): Promise<void>;

  // Read a file from storage
  readFile(relativePath: string): Promise<Buffer | null>;

  // Check if a file exists
  fileExists(relativePath: string): Promise<boolean>;

  // Get file size in bytes
  getFileSize(relativePath: string): Promise<number | null>;

  // Generate a signed URL (S3 only, returns null for local)
  getSignedUrl(relativePath: string, expiresIn: number): Promise<string | null>;

  // Get public URL for a file
  getPublicUrl(relativePath: string): string;
}
```

## Migration Guide

### From Synchronous to Async

If you're upgrading existing code that uses synchronous file operations:

**Before:**
```typescript
const buffer = this.uploads.readStoredFile('/uploads/file.pdf');
```

**After:**
```typescript
const buffer = await this.uploads.readStoredFile('/uploads/file.pdf');
```

### Path Handling

Storage drivers expect **relative paths** without the `/uploads/` prefix:

```typescript
// ✅ Correct
await storage.writeFile('kyc/document.pdf', buffer);

// ❌ Incorrect
await storage.writeFile('/uploads/kyc/document.pdf', buffer);
```

The `UploadsService` handles the path normalization when converting origin URLs to storage paths.

## Private vs Public Files

Files are automatically routed to private or public buckets based on their top-level folder:

**Private folders** (always go to private bucket):
- `kyc/` - KYC verification documents
- `certificates/` - Generated certificates

**Public folders** (go to public bucket):
- `images/` - Course thumbnails, avatars
- `lessons/` - Lesson resources
- `videos/` - Video uploads
- Everything else

## Testing

### Unit Tests

```bash
npm test -- storage.spec
```

### Integration Testing

For local storage, no additional setup is required.

For S3 storage, you can:

1. **Mock the S3 client** (recommended for unit tests)
2. **Use MinIO locally** for integration tests:

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

Then configure:
```env
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

## Deployment Considerations

### Container Redeploys

**Local storage:**
- Files are lost on container restart unless mounted on a persistent volume
- Not suitable for auto-scaling (each instance has its own storage)

**S3 storage:**
- Files persist across container restarts
- Supports horizontal scaling (multiple instances share the same buckets)
- **Recommended for production**

### Performance

**Local storage:**
- Fast for small files
- Synchronous writes block the event loop
- Limited by disk I/O

**S3 storage:**
- Async streaming uploads (non-blocking)
- Scales horizontally
- Network latency for read operations
- Consider using a CDN for public files

### Costs

**Local storage:**
- Disk space only
- Backup costs if using EBS snapshots

**S3 storage:**
- Storage: ~$0.023/GB/month (AWS S3 Standard)
- Requests: $0.005 per 1,000 PUT, $0.0004 per 1,000 GET
- Data transfer: First 100GB/month free, then $0.09/GB
- Consider DigitalOcean Spaces for simpler pricing ($5/month for 250GB)

## Troubleshooting

### "Invalid storage path" error

The storage driver detected a path traversal attempt. Ensure paths:
- Don't start with `/`
- Don't contain `..` segments
- Are relative to the storage root

### S3 connection errors

1. Verify credentials: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`
2. Check bucket names exist and are accessible
3. Verify network connectivity to S3 endpoint
4. For custom endpoints, ensure `S3_ENDPOINT` is correct

### Files not found after switching drivers

When switching from local to S3 (or vice versa), existing files are not migrated automatically. You need to:

1. Upload existing files to the new storage
2. Update database records to point to the new URLs

Consider writing a migration script if you have existing production data.

## Future Enhancements

- [ ] Azure Blob Storage driver
- [ ] Google Cloud Storage driver
- [ ] Automatic migration tool for switching drivers
- [ ] Background job for video transcode to work with S3 URLs
- [ ] Thumbnail extraction from S3-stored videos
- [ ] Multipart upload support for large files (>5GB)
