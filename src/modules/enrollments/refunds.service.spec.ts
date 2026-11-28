import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';
import { RefundsService } from './refunds.service';

describe('RefundsService server analytics', () => {
  const refund = {
    id: 'refund-1',
    enrollmentId: 'enrollment-1',
    studentId: 'student-1',
    status: 'APPROVED',
    approvedAmount: 25,
  };
  const prisma = {
    refund: {
      findUnique: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    enrollment: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    adminAuditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const stellar = { getTransactionStatus: jest.fn() };
  const analytics = { trackEvent: jest.fn() };
  const notifications = {
    notifyAdmins: jest.fn().mockResolvedValue([]),
    notifyUser: jest.fn(),
  };
  let service: RefundsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RefundsService(
      prisma as unknown as PrismaService,
      stellar as unknown as StellarService,
      analytics as unknown as AnalyticsService,
      notifications as unknown as NotificationsService,
    );
    prisma.refund.findUnique.mockResolvedValue(refund);
    prisma.refund.update.mockResolvedValue({ ...refund, status: 'PROCESSED' });
    prisma.refund.aggregate.mockResolvedValue({ _sum: { approvedAmount: null } });
    prisma.enrollment.findUniqueOrThrow.mockResolvedValue({
      id: 'enrollment-1',
      amountPaid: 100,
    });
    prisma.enrollment.update.mockResolvedValue({});
    prisma.$transaction.mockImplementation((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
    prisma.adminAuditLog.create.mockResolvedValue({});
    stellar.getTransactionStatus.mockResolvedValue({ successful: true });
    analytics.trackEvent.mockResolvedValue({});
    notifications.notifyUser.mockResolvedValue({});
  });

  it('records and notifies an approved refund decision', async () => {
    prisma.refund.findUnique.mockResolvedValue({
      ...refund,
      status: 'PENDING',
      requestedAmount: 25,
    });

    await service.approve('refund-1', 'admin-1', { adminNote: 'Eligible for refund' });

    expect(prisma.refund.update).toHaveBeenCalledWith({
      where: { id: 'refund-1' },
      data: expect.objectContaining({
        status: 'APPROVED',
        reviewedById: 'admin-1',
        reviewedAt: expect.any(Date),
        adminNote: 'Eligible for refund',
      }),
    });
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'admin-1',
          action: 'REFUND_APPROVED',
          targetId: 'refund-1',
        }),
      }),
    );
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'student-1',
      NotificationType.REFUND_APPROVED,
      'Refund request approved',
      expect.stringContaining('Eligible for refund'),
      expect.objectContaining({
        refundId: 'refund-1',
        status: 'APPROVED',
        adminNote: 'Eligible for refund',
      }),
    );
  });

  it('records and notifies a rejected refund decision', async () => {
    prisma.refund.findUnique.mockResolvedValue({ ...refund, status: 'PENDING' });

    await service.reject('refund-1', 'admin-1', { reason: 'Outside the refund policy' });

    expect(prisma.refund.update).toHaveBeenCalledWith({
      where: { id: 'refund-1' },
      data: expect.objectContaining({
        status: 'REJECTED',
        reviewedById: 'admin-1',
        reviewedAt: expect.any(Date),
        adminNote: 'Outside the refund policy',
      }),
    });
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'admin-1',
          action: 'REFUND_REJECTED',
          targetId: 'refund-1',
        }),
      }),
    );
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'student-1',
      NotificationType.REFUND_REJECTED,
      'Refund request rejected',
      expect.stringContaining('Outside the refund policy'),
      expect.objectContaining({
        refundId: 'refund-1',
        status: 'REJECTED',
        adminNote: 'Outside the refund policy',
      }),
    );
  });

  it('tracks a refund only after it has been processed', async () => {
    await service.process('refund-1', 'admin-1', { txHash: 'refund-tx' });

    expect(analytics.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'refund_processed',
        properties: expect.objectContaining({
          refundId: 'refund-1',
          enrollmentId: 'enrollment-1',
          amount: 25,
        }),
      }),
      { userId: 'student-1', source: 'server' },
    );
  });
});
