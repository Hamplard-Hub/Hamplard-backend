import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
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
  let service: RefundsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RefundsService(
      prisma as unknown as PrismaService,
      stellar as unknown as StellarService,
      analytics as unknown as AnalyticsService,
    );
    prisma.refund.findUnique.mockResolvedValue(refund);
    prisma.refund.update.mockResolvedValue({ ...refund, status: 'PROCESSED' });
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
