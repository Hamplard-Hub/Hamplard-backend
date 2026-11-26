import { ConflictException } from '@nestjs/common';
import { DisputeReferenceType, DisputeStatus, NotificationType } from '@prisma/client';
import { DisputesService } from './disputes.service';

const enrollment = {
  id: 'enrollment-1',
  studentId: 'student-1',
  txHash: 'tx-hash-1',
};

const dto = {
  referenceType: DisputeReferenceType.ENROLLMENT,
  referenceId: 'enrollment-1',
  subject: 'Content mismatch',
  description: 'The course does not match its description.',
};

describe('DisputesService.file', () => {
  let service: DisputesService;
  let prisma: any;
  let notifications: any;

  beforeEach(() => {
    prisma = {
      enrollment: {
        findUnique: jest.fn().mockResolvedValue(enrollment),
        findFirst: jest.fn().mockResolvedValue(enrollment),
      },
      dispute: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }) => Promise.resolve({ id: 'dispute-1', ...data })),
      },
    };
    notifications = {
      notifyUser: jest.fn().mockResolvedValue(undefined),
      notifyAdmins: jest.fn().mockResolvedValue([]),
    };
    service = new DisputesService(prisma, notifications);
  });

  it('creates the dispute and notifies admins with DISPUTE_FILED (issue #338)', async () => {
    const dispute = await service.file('student-1', dto);

    expect(dispute.status).toBe(DisputeStatus.OPEN);
    expect(notifications.notifyAdmins).toHaveBeenCalledWith(
      NotificationType.DISPUTE_FILED,
      'New dispute filed',
      expect.any(String),
      expect.objectContaining({ disputeId: 'dispute-1', referenceId: 'enrollment-1' }),
    );
  });

  it('returns 409 when an open dispute already exists for the enrollment (issue #339)', async () => {
    prisma.dispute.findFirst.mockResolvedValue({ id: 'dispute-0' });

    await expect(service.file('student-1', dto)).rejects.toThrow(ConflictException);
    expect(prisma.dispute.create).not.toHaveBeenCalled();
    expect(notifications.notifyAdmins).not.toHaveBeenCalled();
  });

  it('checks OPEN/UNDER_REVIEW disputes against both the enrollment id and its payment txHash', async () => {
    await service.file('student-1', {
      ...dto,
      referenceType: DisputeReferenceType.PAYMENT,
      referenceId: 'tx-hash-1',
    });

    expect(prisma.dispute.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
        OR: [
          { referenceType: DisputeReferenceType.ENROLLMENT, referenceId: 'enrollment-1' },
          { referenceType: DisputeReferenceType.PAYMENT, referenceId: 'tx-hash-1' },
        ],
      },
      select: { id: true },
    });
  });
});
