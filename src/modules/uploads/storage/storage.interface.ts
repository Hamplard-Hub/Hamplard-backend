/**
 * Storage interface for file uploads.
 * Implementations: local disk, S3-compatible object storage.
 */
export interface StorageDriver {
  /**
   * Write a file buffer to storage.
   * @param relativePath Path relative to storage root (e.g. 'kyc/file.pdf')
   * @param buffer File content
   * @returns Promise resolving when write completes
   */
  writeFile(relativePath: string, buffer: Buffer): Promise<void>;

  /**
   * Read a file from storage.
   * @param relativePath Path relative to storage root
   * @returns File buffer or null if not found
   */
  readFile(relativePath: string): Promise<Buffer | null>;

  /**
   * Check if a file exists in storage.
   * @param relativePath Path relative to storage root
   * @returns True if file exists
   */
  fileExists(relativePath: string): Promise<boolean>;

  /**
   * Get file size in bytes.
   * @param relativePath Path relative to storage root
   * @returns File size or null if not found
   */
  getFileSize(relativePath: string): Promise<number | null>;

  /**
   * Generate a pre-signed URL for direct file access (S3 only).
   * Local storage returns null — files are served through the API.
   * @param relativePath Path relative to storage root
   * @param expiresIn TTL in seconds
   * @returns Signed URL or null for local storage
   */
  getSignedUrl(relativePath: string, expiresIn: number): Promise<string | null>;

  /**
   * Generate a public URL for a file.
   * For S3, this may be a CDN or bucket URL.
   * For local storage, returns an origin path like /uploads/file.ext
   * @param relativePath Path relative to storage root
   * @returns Public URL
   */
  getPublicUrl(relativePath: string): string;
}
