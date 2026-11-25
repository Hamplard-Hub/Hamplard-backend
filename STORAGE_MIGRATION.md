# Storage Migration Guide - Issue #337

This guide explains how to migrate from local disk storage to S3-compatible object storage.

## Overview

The uploads service now supports pluggable storage drivers:
- **Local storage** (default) - Files stored on disk
- **S3 storage** - Files stored in S3-compatible object storage

## Quick Start

### Install Dependencies

```bash
npm install
```

The required package `@aws-sdk/s3-request-presigner` has been added to `package.json`.

### Configure S3 Storage

Add to your `.env` file:

```env
# Switch to S3 storage
STORAGE_DRIVER=s3

# S3 Buckets
S3_BUCKET=your-private-bucket-name
S3_PUBLIC_BUCKET=your-public-bucket-name

# AWS Credentials
S3_ACCESS_KEY_ID=your-access-key-id
S3_SECRET_ACCESS_KEY=your-secret-access-key
AWS_REGION=us-east-1
```

### For S3-Compatible Services (MinIO, DigitalOcean Spaces, etc.)

```env
STORAGE_DRIVER=s3
S3_BUCKET=your-private-bucket
S3_PUBLIC_BUCKET=your-public-bucket
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1

# Custom endpoint
S3_ENDPOINT=https://sfo3.digitaloceanspaces.com
S3_FORCE_PATH_STYLE=true

# Optional: CDN for public files
S3_CDN_URL=https://cdn.yourdomain.com
```

## Setup Steps

### 1. Create S3 Buckets

Create two buckets in your S3-compatible service:

**Private Bucket** (for KYC, certificates):
- Name: `hamplard-private-uploads`
- Access: Private
- Block all public access

**Public Bucket** (for course materials):
- Name: `hamplard-public-uploads`
- Access: Public read access
- Configure CORS if needed

### 2. Create IAM User/Access Keys

For AWS S3, create an IAM user with the following policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::hamplard-private-uploads/*",
        "arn:aws:s3:::hamplard-public-uploads/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::hamplard-private-uploads",
        "arn:aws:s3:::hamplard-public-uploads"
      ]
    }
  ]
}
```

### 3. Test the Configuration

Test file upload:

```bash
# Start the server
npm run start:dev

# Upload a test file through the API
curl -X POST http://localhost:3000/api/v1/uploads/test \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@test-image.jpg"
```

Check that the file appears in your S3 bucket.

## Migration Checklist

For existing deployments with files on local disk:

- [ ] Create S3 buckets (private and public)
- [ ] Configure IAM user/access keys
- [ ] Add S3 configuration to `.env` (keep `STORAGE_DRIVER=local` for now)
- [ ] Test S3 connectivity with a new upload
- [ ] Migrate existing files to S3:
  ```bash
  # Upload all existing files to S3
  aws s3 sync ./uploads/kyc s3://your-private-bucket/kyc --acl private
  aws s3 sync ./uploads/images s3://your-public-bucket/images --acl public-read
  aws s3 sync ./uploads/videos s3://your-public-bucket/videos --acl public-read
  # etc. for other folders
  ```
- [ ] Update database records (if storing full URLs)
- [ ] Switch to S3 storage: `STORAGE_DRIVER=s3`
- [ ] Restart application
- [ ] Verify file access works
- [ ] Monitor logs for any errors
- [ ] Clean up local disk storage after verification

## Testing S3 Storage

### Using MinIO for Local Testing

Run MinIO locally with Docker:

```bash
docker run -d \
  -p 9000:9000 \
  -p 9001:9001 \
  --name minio \
  -e "MINIO_ROOT_USER=minioadmin" \
  -e "MINIO_ROOT_PASSWORD=minioadmin" \
  minio/minio server /data --console-address ":9001"
```

Access MinIO console at http://localhost:9001

Create buckets:
1. Login with `minioadmin` / `minioadmin`
2. Create `hamplard-private-uploads` bucket
3. Create `hamplard-public-uploads` bucket
4. Set public access policy on the public bucket

Configure `.env.local`:
```env
STORAGE_DRIVER=s3
S3_BUCKET=hamplard-private-uploads
S3_PUBLIC_BUCKET=hamplard-public-uploads
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
AWS_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
```

## Rollback Plan

If you encounter issues after switching to S3:

1. Set `STORAGE_DRIVER=local` in `.env`
2. Restart the application
3. Files on local disk will be served again
4. Investigate S3 issues in logs
5. Fix configuration and retry

## Bucket Naming

Files are automatically routed to private or public buckets:

**Private Bucket:**
- `kyc/*` - KYC verification documents
- `certificates/*` - Generated certificates

**Public Bucket:**
- `images/*` - Course thumbnails, avatars
- `videos/*` - Video uploads
- `lessons/*` - Lesson resources
- Everything else not in private folders

## Cost Estimation

### AWS S3 Costs (us-east-1)

**Storage:**
- Standard: $0.023 per GB/month
- Estimate: 100GB → ~$2.30/month

**Requests:**
- PUT/POST: $0.005 per 1,000 requests
- GET: $0.0004 per 1,000 requests
- Estimate: 10K uploads + 100K downloads → ~$0.09/month

**Data Transfer:**
- First 100 GB/month: Free
- Next 10 TB: $0.09 per GB
- Estimate: 500GB → ~$36/month

**Total estimated monthly cost for small deployment:** ~$40/month

### DigitalOcean Spaces (Simpler Pricing)

- $5/month for 250GB storage + 1TB transfer
- Additional storage: $0.02/GB
- Additional transfer: $0.01/GB

**Recommended for smaller deployments**

## Support

For S3-compatible providers:

- **AWS S3**: https://docs.aws.amazon.com/s3/
- **MinIO**: https://min.io/docs/minio/linux/index.html
- **DigitalOcean Spaces**: https://docs.digitalocean.com/products/spaces/
- **Backblaze B2**: https://www.backblaze.com/b2/docs/

## Troubleshooting

### "Invalid storage path" error
- Paths should be relative without leading `/uploads/`
- Check for `..` segments (path traversal)

### S3 connection timeout
- Verify security groups allow outbound HTTPS (port 443)
- Check S3 endpoint URL is correct
- Verify network connectivity: `curl https://s3.amazonaws.com`

### Access denied errors
- Verify IAM policy grants required permissions
- Check bucket names are correct
- Ensure access keys are valid

### Files not found after switching
- Did you migrate existing files to S3?
- Check bucket names in configuration
- Verify file paths in database match storage paths

### Slow upload performance
- S3 uploads are async and non-blocking
- For large files, consider multipart upload (future enhancement)
- Check network bandwidth between server and S3

## Next Steps

After successful S3 migration:

1. Set up CloudFront or CDN for public bucket
2. Configure lifecycle policies for old files
3. Enable versioning for critical files
4. Set up S3 bucket logging
5. Configure bucket encryption
6. Set up automated backups
