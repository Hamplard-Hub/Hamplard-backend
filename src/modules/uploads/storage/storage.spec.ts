import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { LocalStorageDriver } from './local.storage';
import { S3StorageDriver } from './s3.storage';
import { StorageFactory } from './storage.factory';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    PutObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
    HeadObjectCommand: jest.fn(),
    NotFound: class NotFound extends Error {},
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com'),
}));

describe('Storage Drivers', () => {
  describe('LocalStorageDriver', () => {
    let driver: LocalStorageDriver;
    let configService: ConfigService;
    const testUploadDir = path.join(__dirname, '../../../../test-uploads');

    beforeEach(async () => {
      configService = new ConfigService({
        UPLOAD_DIR: testUploadDir,
      });

      driver = new LocalStorageDriver(configService);
    });

    afterEach(async () => {
      // Clean up test directory
      try {
        await fs.rm(testUploadDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    it('should write and read a file', async () => {
      const relativePath = 'test/sample.txt';
      const content = Buffer.from('Hello, World!');

      await driver.writeFile(relativePath, content);
      const result = await driver.readFile(relativePath);

      expect(result).toEqual(content);
    });

    it('should return null for non-existent file', async () => {
      const result = await driver.readFile('non-existent/file.txt');
      expect(result).toBeNull();
    });

    it('should check file existence', async () => {
      const relativePath = 'test/exists.txt';
      const content = Buffer.from('Test content');

      await driver.writeFile(relativePath, content);

      expect(await driver.fileExists(relativePath)).toBe(true);
      expect(await driver.fileExists('non-existent.txt')).toBe(false);
    });

    it('should get file size', async () => {
      const relativePath = 'test/sized.txt';
      const content = Buffer.from('1234567890');

      await driver.writeFile(relativePath, content);

      const size = await driver.getFileSize(relativePath);
      expect(size).toBe(10);
    });

    it('should return null for signed URL (not supported)', async () => {
      const url = await driver.getSignedUrl('test/file.txt', 3600);
      expect(url).toBeNull();
    });

    it('should generate public URL', () => {
      const url = driver.getPublicUrl('test/file.txt');
      expect(url).toBe('/uploads/test/file.txt');
    });

    it('should prevent path traversal', async () => {
      await expect(
        driver.writeFile('../../../etc/passwd', Buffer.from('hack')),
      ).rejects.toThrow('Invalid storage path');
    });
  });

  describe('S3StorageDriver', () => {
    let driver: S3StorageDriver;
    let configService: ConfigService;
    let mockS3Client: any;

    beforeEach(async () => {
      configService = new ConfigService({
        S3_BUCKET: 'test-private-bucket',
        S3_PUBLIC_BUCKET: 'test-public-bucket',
        S3_ACCESS_KEY_ID: 'test-key-id',
        S3_SECRET_ACCESS_KEY: 'test-secret-key',
        AWS_REGION: 'us-east-1',
      });

      const { S3Client } = require('@aws-sdk/client-s3');
      driver = new S3StorageDriver(configService);
      mockS3Client = S3Client.mock.results[S3Client.mock.results.length - 1].value;
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should write file to S3', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      const relativePath = 'test/sample.txt';
      const content = Buffer.from('Hello, S3!');

      await driver.writeFile(relativePath, content);

      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it('should read file from S3', async () => {
      const content = Buffer.from('Hello from S3!');
      const mockStream = {
        on: jest.fn((event, handler) => {
          if (event === 'data') {
            handler(content);
          }
          if (event === 'end') {
            handler();
          }
          return mockStream;
        }),
      };

      mockS3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      const result = await driver.readFile('test/sample.txt');

      expect(result).toEqual(content);
    });

    it('should return null for non-existent file', async () => {
      const { NotFound } = require('@aws-sdk/client-s3');
      mockS3Client.send.mockRejectedValueOnce(new NotFound({ $metadata: {}, message: 'Not found' }));

      const result = await driver.readFile('non-existent.txt');
      expect(result).toBeNull();
    });

    it('should check file existence', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      const exists = await driver.fileExists('test/file.txt');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent file check', async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });

      const exists = await driver.fileExists('non-existent.txt');
      expect(exists).toBe(false);
    });

    it('should get file size', async () => {
      mockS3Client.send.mockResolvedValueOnce({
        ContentLength: 1024,
      });

      const size = await driver.getFileSize('test/file.txt');
      expect(size).toBe(1024);
    });

    it('should generate signed URL', async () => {
      const url = await driver.getSignedUrl('test/file.txt', 3600);
      expect(url).toBe('https://signed-url.example.com');
    });

    it('should generate public URL', () => {
      const url = driver.getPublicUrl('images/photo.jpg');
      expect(url).toContain('test-public-bucket');
      expect(url).toContain('images/photo.jpg');
    });

    it('should use private bucket for KYC files', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      await driver.writeFile('kyc/document.pdf', Buffer.from('KYC doc'));

      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const lastCall = PutObjectCommand.mock.calls[PutObjectCommand.mock.calls.length - 1];
      expect(lastCall[0].Bucket).toBe('test-private-bucket');
    });

    it('should use public bucket for non-KYC files', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      await driver.writeFile('images/photo.jpg', Buffer.from('Photo'));

      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const lastCall = PutObjectCommand.mock.calls[PutObjectCommand.mock.calls.length - 1];
      expect(lastCall[0].Bucket).toBe('test-public-bucket');
    });
  });

  describe('StorageFactory', () => {
    it('should create local storage driver by default', () => {
      const configService = new ConfigService({
        UPLOAD_DIR: './uploads',
      });

      const factory = new StorageFactory(configService);
      const driver = factory.createStorageDriver();

      expect(driver).toBeInstanceOf(LocalStorageDriver);
    });

    it('should create S3 storage driver when configured', () => {
      const configService = new ConfigService({
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret',
      });

      const factory = new StorageFactory(configService);
      const driver = factory.createStorageDriver();

      expect(driver).toBeInstanceOf(S3StorageDriver);
    });
  });
});
