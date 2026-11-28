import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { DistributedLockService } from './distributed-lock.service';

describe('DistributedLockService', () => {
  let service: DistributedLockService;
  let redisMock: jest.Mocked<Redis>;

  beforeEach(async () => {
    redisMock = {
      set: jest.fn(),
      del: jest.fn(),
      ping: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DistributedLockService,
        {
          provide: 'default_IORedisModuleKey',
          useValue: redisMock,
        },
      ],
    }).compile();

    // Manually inject the mock using reflection
    service = module.get<DistributedLockService>(DistributedLockService);
    (service as any).redis = redisMock;
  });

  describe('acquireLock', () => {
    it('should acquire lock when key does not exist', async () => {
      redisMock.set.mockResolvedValue('OK' as any);

      const result = await service.acquireLock('test-lock', 5000);

      expect(result).toBe(true);
      expect(redisMock.set).toHaveBeenCalledWith(
        'hamplard:lock:test-lock',
        expect.stringContaining('instance:'),
        'PX',
        5000,
        'NX',
      );
    });

    it('should not acquire lock when key already exists', async () => {
      redisMock.set.mockResolvedValue(null);

      const result = await service.acquireLock('test-lock', 5000);

      expect(result).toBe(false);
      expect(redisMock.set).toHaveBeenCalledWith(
        'hamplard:lock:test-lock',
        expect.stringContaining('instance:'),
        'PX',
        5000,
        'NX',
      );
    });

    it('should throw error if lock name is empty', async () => {
      await expect(service.acquireLock('', 5000)).rejects.toThrow('Lock name cannot be empty');
    });

    it('should throw error if TTL is invalid', async () => {
      await expect(service.acquireLock('test-lock', -1000)).rejects.toThrow(
        'TTL must be a positive integer',
      );
    });

    it('should throw error if Redis operation fails', async () => {
      redisMock.set.mockRejectedValue(new Error('Redis connection failed'));

      await expect(service.acquireLock('test-lock', 5000)).rejects.toThrow('Redis connection failed');
    });
  });

  describe('releaseLock', () => {
    it('should release lock successfully', async () => {
      redisMock.del.mockResolvedValue(1);

      await service.releaseLock('test-lock');

      expect(redisMock.del).toHaveBeenCalledWith('hamplard:lock:test-lock');
    });

    it('should handle non-existent lock gracefully', async () => {
      redisMock.del.mockResolvedValue(0);

      await expect(service.releaseLock('test-lock')).resolves.not.toThrow();
      expect(redisMock.del).toHaveBeenCalledWith('hamplard:lock:test-lock');
    });

    it('should throw error if lock name is empty', async () => {
      await expect(service.releaseLock('')).rejects.toThrow('Lock name cannot be empty');
    });

    it('should throw error if Redis operation fails', async () => {
      redisMock.del.mockRejectedValue(new Error('Redis connection failed'));

      await expect(service.releaseLock('test-lock')).rejects.toThrow('Redis connection failed');
    });
  });

  describe('withLock', () => {
    it('should execute function if lock is acquired', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      redisMock.set.mockResolvedValue('OK' as any);
      redisMock.del.mockResolvedValue(1);

      const result = await service.withLock('test-lock', 5000, mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalled();
      expect(redisMock.set).toHaveBeenCalled();
      expect(redisMock.del).toHaveBeenCalled();
    });

    it('should not execute function if lock is not acquired', async () => {
      const mockFn = jest.fn();
      redisMock.set.mockResolvedValue(null);

      const result = await service.withLock('test-lock', 5000, mockFn);

      expect(result).toBeNull();
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should release lock even if function throws', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Function failed'));
      redisMock.set.mockResolvedValue('OK' as any);
      redisMock.del.mockResolvedValue(1);

      await expect(service.withLock('test-lock', 5000, mockFn)).rejects.toThrow('Function failed');

      expect(mockFn).toHaveBeenCalled();
      expect(redisMock.del).toHaveBeenCalled();
    });

    it('should return function result with correct type', async () => {
      const mockFn = jest.fn().mockResolvedValue({ data: 'test' });
      redisMock.set.mockResolvedValue('OK' as any);
      redisMock.del.mockResolvedValue(1);

      const result = await service.withLock('test-lock', 5000, mockFn);

      expect(result).toEqual({ data: 'test' });
    });
  });

  describe('healthCheck', () => {
    it('should return true if Redis responds with PONG', async () => {
      redisMock.ping.mockResolvedValue('PONG');

      const result = await service.healthCheck();

      expect(result).toBe(true);
    });

    it('should return false if Redis connection fails', async () => {
      redisMock.ping.mockRejectedValue(new Error('Connection refused'));

      const result = await service.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe('concurrency prevention', () => {
    it('should prevent concurrent execution of same lock', async () => {
      const mockFn1 = jest.fn().mockImplementation(() => new Promise(r => setTimeout(r, 100)));
      const mockFn2 = jest.fn().mockResolvedValue('second');
      let setCalls = 0;

      redisMock.set.mockImplementation(() => {
        setCalls += 1;
        return Promise.resolve(setCalls === 1 ? 'OK' : null) as any;
      });
      redisMock.del.mockResolvedValue(1);

      // Start first lock (will acquire it)
      const promise1 = service.withLock('concurrent-test', 5000, mockFn1);

      // Try second lock immediately (should not acquire)
      const promise2 = service.withLock('concurrent-test', 5000, mockFn2);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).not.toBeNull();
      expect(result2).toBeNull(); // Second lock was not acquired
    });
  });
});
