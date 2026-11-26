import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageDriver } from './storage.interface';
import { Readable } from 'stream';

/**
 * S3-compatible object storage implementation.
 * Supports AWS S3, MinIO, DigitalOcean Spaces, and other S3-compatible services.
 */
@Injectable()
export class S3StorageDriver implements StorageDriver {
  private readonly logger = new Logger(S3StorageDriver.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly publicBucket: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly cdnUrl?: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('S3_BUCKET');
    this.publicBucket = this.config.get<string>('S3_PUBLIC_BUCKET', this.bucket);
    this.region = this.config.get<string>('AWS_REGION', 'us-east-1');
    this.endpoint = this.config.get<string>('S3_ENDPOINT');
    this.cdnUrl = this.config.get<string>('S3_CDN_URL');

    const clientConfig: any = {
      region: this.region,
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    };

    // Support for S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
    if (this.endpoint) {
      clientConfig.endpoint = this.endpoint;
      clientConfig.forcePathStyle = this.config.get<boolean>('S3_FORCE_PATH_STYLE', true);
    }

    this.s3Client = new S3Client(clientConfig);

    this.logger.log(
      `S3 storage initialized: bucket=${this.bucket}, region=${this.region}${
        this.endpoint ? `, endpoint=${this.endpoint}` : ''
      }`,
    );
  }

  async writeFile(relativePath: string, buffer: Buffer): Promise<void> {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: this.detectContentType(relativePath),
      });

      await this.s3Client.send(command);
      this.logger.log(`File uploaded to S3: ${bucket}/${key} (${buffer.length} bytes)`);
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: ${bucket}/${key}`, error);
      throw error;
    }
  }

  async readFile(relativePath: string): Promise<Buffer | null> {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        return null;
      }

      // Convert stream to buffer
      return await this.streamToBuffer(response.Body as Readable);
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error instanceof NotFound) {
        return null;
      }
      this.logger.error(`Failed to read file from S3: ${bucket}/${key}`, error);
      throw error;
    }
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      this.logger.error(`Failed to check file existence in S3: ${bucket}/${key}`, error);
      throw error;
    }
  }

  async getFileSize(relativePath: string): Promise<number | null> {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      return response.ContentLength ?? null;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      this.logger.error(`Failed to get file size from S3: ${bucket}/${key}`, error);
      throw error;
    }
  }

  async getSignedUrl(relativePath: string, expiresIn: number): Promise<string | null> {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      return signedUrl;
    } catch (error) {
      this.logger.error(`Failed to generate signed URL for S3: ${bucket}/${key}`, error);
      throw error;
    }
  }

  getPublicUrl(relativePath: string): string {
    const { bucket, key } = this.getBucketAndKey(relativePath);

    // If CDN URL is configured, use it
    if (this.cdnUrl) {
      return `${this.cdnUrl}/${key}`;
    }

    // If using custom endpoint (e.g., MinIO, DigitalOcean Spaces)
    if (this.endpoint) {
      const endpointUrl = this.endpoint.replace(/\/$/, '');
      return `${endpointUrl}/${bucket}/${key}`;
    }

    // Standard AWS S3 URL
    return `https://${bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  /**
   * Determine which bucket and key to use based on the relative path.
   * KYC files go to the private bucket; everything else to the public bucket.
   */
  private getBucketAndKey(relativePath: string): { bucket: string; key: string } {
    const isPrivate = this.isPrivatePath(relativePath);
    const bucket = isPrivate ? this.bucket : this.publicBucket;

    // S3 keys should use forward slashes and not start with a slash
    const key = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

    return { bucket, key };
  }

  /**
   * Check if a path should be stored in the private bucket.
   * Currently, only KYC and certificates are private.
   */
  private isPrivatePath(relativePath: string): boolean {
    const privateFolders = ['kyc', 'certificates'];
    const topFolder = relativePath.split(/[/\\]/)[0];
    return privateFolders.includes(topFolder);
  }

  /**
   * Detect content type from file extension for proper S3 metadata.
   */
  private detectContentType(relativePath: string): string {
    const ext = relativePath.split('.').pop()?.toLowerCase();

    const contentTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      pdf: 'application/pdf',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      mkv: 'video/x-matroska',
    };

    return contentTypes[ext || ''] || 'application/octet-stream';
  }

  /**
   * Convert a readable stream to a buffer.
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
