# Storage System Quick Reference

## Environment Variables

```bash
# Storage Driver Selection
STORAGE_DRIVER=local                # Options: 'local' (default) or 's3'

# Local Storage
UPLOAD_DIR=./uploads               # Where files are stored locally

# S3 Storage
S3_BUCKET=private-bucket           # Private bucket (KYC, certificates)
S3_PUBLIC_BUCKET=public-bucket     # Public bucket (images, videos)
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
S3_ENDPOINT=https://s3.example.com # Optional for S3-compatible services
S3_FORCE_PATH_STYLE=true           # For MinIO, DigitalOcean Spaces
S3_CDN_URL=https://cdn.domain.com  # Optional CDN URL
```

## File Routing

| Path | Bucket | Access |
|------|--------|--------|
| `kyc/*` | Private | Signed URL only |
| `certificates/*` | Private | Signed URL only |
| `images/*` | Public | Direct access |
| `videos/*` | Public | Direct access |
| `lessons/*` | Public | Direct access |
| Everything else | Public | Direct access |

## Code Examples

### Upload a File

```typescript
import { UploadsService } from './modules/uploads/uploads.service';

// In your service
async uploadFile(file: Express.Multer.File) {
  // Automatically uses configured storage driver
  const result = await this.uploads.saveFile(
    file,
    'images',        // subfolder
    'public',        // visibility: 'public' | 'private'
    'image'          // category: 'image' | 'document' | 'video' | 'kyc'
  );
  
  // Returns:
  // {
  //   cdnUrl: 'https://cdn.example.com/images/uuid.jpg',
  //   originUrl: '/uploads/images/uuid.jpg',
  //   url: 'https://cdn.example.com/images/uuid.jpg' (deprecated)
  // }
  
  return result.cdnUrl;
}
```

### Upload KYC Document

```typescript
async uploadKyc(file: Express.Multer.File, instructorId: string) {
  // Always goes to private bucket
  const result = await this.uploads.saveKycDocument(file, instructorId);
  
  // Returns signed URL for secure access
  return result;
}
```

### Read a Stored File

```typescript
async getFile(originPath: string): Promise<Buffer | null> {
  // Works with both local and S3 storage
  const buffer = await this.uploads.readStoredFile(originPath);
  
  if (!buffer) {
    throw new NotFoundException('File not found');
  }
  
  return buffer;
}
```

### Check File Existence

```typescript
async fileExists(originPath: string): Promise<boolean> {
  const info = await this.uploads.getStoredFileInfo(originPath);
  return info !== null;
}
```

### Get File Info

```typescript
async getFileInfo(originPath: string) {
  const info = await this.uploads.getStoredFileInfo(originPath);
  
  // Returns:
  // {
  //   absolutePath: string,  // For local: /path/to/file; for S3: relative path
  //   relativePath: string,  // kyc/file.pdf
  //   filename: string,      // file.pdf
  //   size: number,          // bytes
  //   contentType: string,   // image/jpeg, application/pdf, etc.
  //   inline: boolean,       // true if safe to display inline
  //   isPrivate: boolean     // true if in private folder
  // }
  
  return info;
}
```

## Direct Storage Driver Usage

```typescript
import { StorageDriver, STORAGE_DRIVER } from './modules/uploads/storage';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class MyService {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  async uploadCustom(buffer: Buffer, path: string) {
    // Write file
    await this.storage.writeFile('custom/file.txt', buffer);
    
    // Read file
    const data = await this.storage.readFile('custom/file.txt');
    
    // Check existence
    const exists = await this.storage.fileExists('custom/file.txt');
    
    // Get size
    const size = await this.storage.getFileSize('custom/file.txt');
    
    // Get public URL
    const url = this.storage.getPublicUrl('custom/file.txt');
    
    // Get signed URL (S3 only, returns null for local)
    const signedUrl = await this.storage.getSignedUrl('custom/file.txt', 3600);
  }
}
```

## Testing

### Mock Storage in Tests

```typescript
import { STORAGE_DRIVER } from './modules/uploads/storage';

const mockStorage = {
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('test')),
  fileExists: jest.fn().mockResolvedValue(true),
  getFileSize: jest.fn().mockResolvedValue(1024),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com'),
  getPublicUrl: jest.fn().mockReturnValue('/uploads/file.txt'),
};

const module = await Test.createTestingModule({
  providers: [
    YourService,
    {
      provide: STORAGE_DRIVER,
      useValue: mockStorage,
    },
  ],
}).compile();
```

## Common Patterns

### Save and Return URL

```typescript
async uploadAndGetUrl(file: Express.Multer.File): Promise<string> {
  const result = await this.uploads.saveFile(file, 'images', 'public', 'image');
  return result.cdnUrl;
}
```

### Save with Custom Filename

```typescript
async saveWithCustomName(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const result = await this.uploads.saveBuffer(
    buffer,
    'certificates',
    filename,
    'private'
  );
  return result.cdnUrl;
}
```

### Stream File to Response

```typescript
import { StreamableFile } from '@nestjs/common';
import { Response } from 'express';

@Get('download/:id')
async downloadFile(
  @Param('id') id: string,
  @Res({ passthrough: true }) res: Response
): Promise<StreamableFile> {
  const file = await this.uploads.getStoredFileInfo(`/uploads/files/${id}.pdf`);
  
  if (!file) {
    throw new NotFoundException();
  }
  
  const buffer = await this.uploads.readStoredFile(`/uploads/files/${id}.pdf`);
  
  res.set({
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
  });
  
  return new StreamableFile(buffer);
}
```

## Migration Checklist

- [ ] Install dependencies: `npm install`
- [ ] Create S3 buckets (private + public)
- [ ] Add S3 credentials to `.env`
- [ ] Test with `STORAGE_DRIVER=local` first
- [ ] Upload test file, verify in S3
- [ ] Migrate existing files to S3
- [ ] Switch to `STORAGE_DRIVER=s3`
- [ ] Test all upload/download flows
- [ ] Monitor logs for errors

## Troubleshooting Quick Fixes

| Issue | Solution |
|-------|----------|
| "Invalid storage path" | Check path format: should be relative, no leading `/uploads/` |
| S3 connection fails | Verify credentials, endpoint, region in `.env` |
| Files not found | Check bucket names, verify files were migrated |
| Upload slow/hangs | Check network, S3 endpoint reachability |
| Access denied | Verify IAM policy, bucket permissions |

## Performance Tips

1. **Local Storage:**
   - Fast for small deployments
   - Use SSD for better performance
   - Not suitable for multi-instance setups

2. **S3 Storage:**
   - Async uploads (non-blocking)
   - Use CDN for frequently accessed files
   - Consider multipart upload for files >100MB
   - Enable transfer acceleration for global deployments

## Security Best Practices

1. **Never expose S3 credentials** in client code
2. **Use signed URLs** for private files
3. **Set bucket policies** correctly (private vs public)
4. **Enable encryption** at rest for sensitive data
5. **Rotate access keys** regularly
6. **Use IAM roles** in production (EC2, ECS)
7. **Enable bucket logging** for audit trails

## AWS CLI Commands

```bash
# List files in bucket
aws s3 ls s3://your-bucket/kyc/

# Upload file
aws s3 cp file.pdf s3://your-bucket/kyc/file.pdf

# Download file
aws s3 cp s3://your-bucket/kyc/file.pdf ./file.pdf

# Sync directory to S3
aws s3 sync ./uploads/kyc s3://your-bucket/kyc/

# Sync S3 to directory
aws s3 sync s3://your-bucket/kyc/ ./uploads/kyc/

# Delete file
aws s3 rm s3://your-bucket/kyc/file.pdf

# Generate presigned URL (expires in 1 hour)
aws s3 presign s3://your-bucket/kyc/file.pdf --expires-in 3600
```

## Resources

- [Storage Implementation README](../src/modules/uploads/storage/README.md)
- [Migration Guide](../STORAGE_MIGRATION.md)
- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [MinIO Documentation](https://min.io/docs/)
- [DigitalOcean Spaces](https://docs.digitalocean.com/products/spaces/)
