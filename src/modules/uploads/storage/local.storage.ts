import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StorageDriver } from './storage.interface';

/**
 * Local disk storage implementation.
 * Files are written synchronously during migration period to maintain
 * compatibility; async methods are provided for future transitions.
 */
@Injectable()
export class LocalStorageDriver implements StorageDriver {
  private readonly logger = new Logger(LocalStorageDriver.name);
  private readonly uploadDir: string;

  constructor(private readonly config: ConfigService) {
    this.uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');
    this.ensureDirSync(this.uploadDir);
  }

  async writeFile(relativePath: string, buffer: Buffer): Promise<void> {
    const absolutePath = this.getAbsolutePath(relativePath);
    const dir = path.dirname(absolutePath);

    // Ensure parent directory exists
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(absolutePath, buffer);
    this.logger.log(`File written to local storage: ${relativePath}`);
  }

  async readFile(relativePath: string): Promise<Buffer | null> {
    const absolutePath = this.getAbsolutePath(relativePath);

    try {
      return await fs.readFile(absolutePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const absolutePath = this.getAbsolutePath(relativePath);

    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  async getFileSize(relativePath: string): Promise<number | null> {
    const absolutePath = this.getAbsolutePath(relativePath);

    try {
      const stats = await fs.stat(absolutePath);
      return stats.size;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async getSignedUrl(_relativePath: string, _expiresIn: number): Promise<string | null> {
    // Local storage does not support signed URLs — files are served through the API
    return null;
  }

  getPublicUrl(relativePath: string): string {
    // Return origin path for local storage
    return `/uploads/${relativePath}`;
  }

  /**
   * Synchronous file write for compatibility with existing code.
   * @deprecated Use writeFile() async method instead
   */
  writeFileSync(relativePath: string, buffer: Buffer): void {
    const absolutePath = this.getAbsolutePath(relativePath);
    const dir = path.dirname(absolutePath);

    // Ensure parent directory exists
    this.ensureDirSync(dir);

    fsSync.writeFileSync(absolutePath, buffer);
    this.logger.log(`File written to local storage (sync): ${relativePath}`);
  }

  /**
   * Synchronous file read for compatibility with existing code.
   * @deprecated Use readFile() async method instead
   */
  readFileSync(relativePath: string): Buffer | null {
    const absolutePath = this.getAbsolutePath(relativePath);

    try {
      return fsSync.readFileSync(absolutePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Synchronous file existence check for compatibility.
   * @deprecated Use fileExists() async method instead
   */
  fileExistsSync(relativePath: string): boolean {
    const absolutePath = this.getAbsolutePath(relativePath);
    return fsSync.existsSync(absolutePath);
  }

  /**
   * Synchronous file size retrieval for compatibility.
   * @deprecated Use getFileSize() async method instead
   */
  getFileSizeSync(relativePath: string): number | null {
    const absolutePath = this.getAbsolutePath(relativePath);

    try {
      const stats = fsSync.statSync(absolutePath);
      return stats.size;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private getAbsolutePath(relativePath: string): string {
    const root = path.resolve(this.uploadDir);
    const absolutePath = path.resolve(root, relativePath);

    // Security check: prevent path traversal
    if (!absolutePath.startsWith(root + path.sep) && absolutePath !== root) {
      throw new Error(`Invalid storage path: ${relativePath}`);
    }

    return absolutePath;
  }

  private ensureDirSync(dirPath: string): void {
    if (!fsSync.existsSync(dirPath)) {
      fsSync.mkdirSync(dirPath, { recursive: true });
    }
  }
}
