import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

describe('NotificationsService', () => {
  let service: NotificationsService;

  const mockPrisma = {
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    notificationPreference: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    notificationDigestPreference: {
      findUnique: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      upsert: jest.fn(),
    },
    notificationDeviceToken: {
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockQueue = {
    enqueueNotificationEmail: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  };

  const countQueries = () =>
    Object.values(mockPrisma).reduce((total, delegate) => {
      if (typeof delegate === 'function') return total + (delegate as jest.Mock).mock.calls.length;
      return (
        total +
        Object.values(delegate).reduce(
          (sum, fn) => sum + (fn as jest.Mock).mock.calls.length,
          0,
        )
      );
    }, 0);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: QueueService, useValue: mockQueue },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    jest.clearAllMocks();

    mockPrisma.notification.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: `notif-${Math.random()}`, ...data }),
    );
    mockPrisma.notificationDigestPreference.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.notificationDeviceToken.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
    mockQueue.enqueueNotificationEmail.mockResolvedValue({ id: 'job-1' });
  });

  describe('notifyUser', () => {
    it('treats a missing preference row as defaults without inserting rows', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const result = await service.notifyUser(
        'user-1',
        NotificationType.COURSE_APPROVED,
        'Approved',
        'Your course was approved',
      );

      expect(result?.emailJobId).toBe('job-1');
      expect(mockQueue.enqueueNotificationEmail).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notificationPreference.create).not.toHaveBeenCalled();
      expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.notificationDigestPreference.createMany).toHaveBeenCalledWith({
        data: [{ userId: 'user-1', emailEnabled: true }],
        skipDuplicates: true,
      });
    });

    it('delivers emails for every concurrent notification to a new user', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          service.notifyUser('user-1', NotificationType.NEW_ENROLLMENT, `Title ${i}`, 'Message'),
        ),
      );

      expect(results.every((r) => r?.emailJobId === 'job-1')).toBe(true);
      expect(mockQueue.enqueueNotificationEmail).toHaveBeenCalledTimes(5);
      expect(mockPrisma.notificationPreference.create).not.toHaveBeenCalled();
    });

    it('uses a constant number of queries per notification', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      await service.notifyUser('user-1', NotificationType.COURSE_APPROVED, 'T', 'M');
      const first = countQueries();

      jest.clearAllMocks();
      mockPrisma.notification.create.mockResolvedValue({ id: 'n-2' });
      mockPrisma.notificationDigestPreference.createMany.mockResolvedValue({ count: 0 });
      mockPrisma.notificationDeviceToken.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        email: true,
        push: true,
        inApp: true,
      });

      await service.notifyUser('user-1', NotificationType.COURSE_APPROVED, 'T', 'M');

      expect(countQueries()).toBe(first);
      expect(first).toBeLessThanOrEqual(5);
    });

    it('respects a disabled email channel', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        email: false,
        push: false,
        inApp: true,
      });

      await service.notifyUser('user-1', NotificationType.COURSE_APPROVED, 'T', 'M');

      expect(mockQueue.enqueueNotificationEmail).not.toHaveBeenCalled();
    });

    it('still stores the notification when inApp is disabled', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        email: true,
        push: true,
        inApp: false,
      });

      await service.notifyUser('user-1', NotificationType.COURSE_APPROVED, 'T', 'M');

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyAdmins (issue #338)', () => {
    it('creates a notification for every active admin', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const results = await service.notifyAdmins(
        NotificationType.DISPUTE_FILED,
        'New dispute filed',
        'A student filed a dispute',
        { disputeId: 'dispute-1' },
      );

      expect(results).toHaveLength(2);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ role: 'ADMIN' }) }),
      );
      for (const userId of ['admin-1', 'admin-2']) {
        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ userId, type: NotificationType.DISPUTE_FILED }),
        });
      }
    });

    it('skips admins who disabled every channel for the type', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'admin-2' }]);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      const results = await service.notifyAdmins(NotificationType.KYC_SUBMITTED, 'T', 'M');

      expect(results).toHaveLength(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'admin-1' }),
      });
    });

    it('never throws when the admin lookup fails', async () => {
      mockPrisma.user.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.notifyAdmins(NotificationType.REFUND_REQUESTED, 'T', 'M'),
      ).resolves.toEqual([]);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('findForUser', () => {
    beforeEach(() => {
      mockPrisma.$transaction.mockImplementation((ops) => Promise.all(ops));
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);
    });

    it('hides notification types whose inApp channel is disabled', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { type: NotificationType.PAYMENT_RECEIVED },
      ]);

      await service.findForUser('user-1');

      expect(mockPrisma.notificationPreference.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', inApp: false },
        select: { type: true },
      });
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', type: { notIn: [NotificationType.PAYMENT_RECEIVED] } },
        }),
      );
    });

    it('returns read and unread notifications when unreadOnly is false', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([]);

      await service.findForUser('user-1', false);

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
    });

    it('returns only unread notifications when unreadOnly is true', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([]);

      await service.findForUser('user-1', true);

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', read: false } }),
      );
    });
  });

  describe('getPreferences', () => {
    it('fills missing types with defaults without writing', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { type: NotificationType.COURSE_APPROVED, email: false, push: true, inApp: false },
      ]);

      const prefs = await service.getPreferences('user-1');

      expect(prefs[NotificationType.COURSE_APPROVED]).toEqual({ email: false, push: true, inApp: false });
      expect(prefs[NotificationType.NEW_ENROLLMENT]).toEqual({ email: true, push: true, inApp: true });
      expect(Object.keys(prefs)).toHaveLength(Object.values(NotificationType).length);
      expect(mockPrisma.notificationPreference.create).not.toHaveBeenCalled();
    });
  });

  describe('updatePreference', () => {
    it('only updates the channels provided in the body', async () => {
      mockPrisma.notificationPreference.upsert.mockResolvedValue({});

      await service.updatePreference('user-1', NotificationType.COURSE_APPROVED, { push: false });

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId_type: { userId: 'user-1', type: NotificationType.COURSE_APPROVED } },
        update: { push: false },
        create: {
          userId: 'user-1',
          type: NotificationType.COURSE_APPROVED,
          email: true,
          push: false,
          inApp: true,
        },
      });
      expect(mockPrisma.notificationPreference.create).not.toHaveBeenCalled();
    });
  });

  describe('DTOs', () => {
    it('parses unreadOnly=false as false', () => {
      const dto = plainToInstance(
        QueryNotificationsDto,
        { unreadOnly: 'false' },
        { enableImplicitConversion: true },
      );
      expect(dto.unreadOnly).toBe(false);
      expect(validateSync(dto)).toHaveLength(0);
    });

    it('rejects non-boolean preference values', () => {
      const dto = plainToInstance(UpdateNotificationPreferenceDto, { email: 'nope' });
      expect(validateSync(dto)).toHaveLength(1);
    });
  });
});
