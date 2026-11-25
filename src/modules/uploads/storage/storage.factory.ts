import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver } from './storage.interface';
import { LocalStorageDriver } from './local.storage';
import { S3StorageDriver } from './s3.storage';

export type StorageDriverType = 'local' | 's3';

/**
 * Factory for creating storage driver instances based on configuration.
 */
@Injectable()
export class StorageFactory {
  private readonly logger = new Logger(StorageFactory.name);

  constructor(private readonly config: ConfigService) {}

  createStorageDriver(): StorageDriver {
    const driverType = this.config.get<StorageDriverType>('STORAGE_DRIVER', 'local');

    switch (driverType) {
      case 's3':
        this.logger.log('Initializing S3 storage driver');
        return new S3StorageDriver(this.config);

      case 'local':
      default:
        this.logger.log('Initializing local storage driver');
        return new LocalStorageDriver(this.config);
    }
  }
}

/**
 * Injection token for the storage driver.
 */
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
