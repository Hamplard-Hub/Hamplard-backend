import { BadRequestException } from "@nestjs/common";
import { KycStatus, NotificationType } from "@prisma/client";
import { KycService } from "./kyc.service";

const approvedSubmission = {
  id: "submission-1",
  instructorId: "instructor-1",
  status: KycStatus.APPROVED,
  adminNotes: null,
  reviewedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("KycService verification revocation", () => {
  let service: KycService;
  let prisma: any;
  let notifications: any;
  let transaction: any;

  beforeEach(() => {
    const revokedSubmission = {
      ...approvedSubmission,
      status: KycStatus.REVOKED,
    };
    transaction = {
      kycSubmission: {
        update: jest.fn().mockResolvedValue(approvedSubmission),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ status: KycStatus.APPROVED }),
        findUnique: jest.fn().mockResolvedValue(revokedSubmission),
      },
      user: {
        update: jest
          .fn()
          .mockResolvedValue({ id: "instructor-1", isVerified: false }),
      },
    };
    prisma = {
      kycSubmission: {
        findUnique: jest.fn().mockResolvedValue(approvedSubmission),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(transaction)),
    };
    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };
    service = new KycService(prisma, notifications, {} as any);
  });

  it("revokes all instructor approvals, clears the verification flag, and notifies the instructor", async () => {
    const result = await service.revoke(
      "submission-1",
      "admin-1",
      "Fraudulent document",
    );

    expect(transaction.kycSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instructorId: "instructor-1", status: KycStatus.APPROVED },
        data: expect.objectContaining({
          status: KycStatus.REVOKED,
          adminNotes: "Fraudulent document",
          reviewedById: "admin-1",
          reviewedAt: expect.any(Date),
        }),
      }),
    );
    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: "instructor-1" },
      data: { isVerified: false },
    });
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      "instructor-1",
      NotificationType.KYC_REVOKED,
      "Identity verification revoked",
      expect.stringContaining("Fraudulent document"),
      { submissionId: "submission-1" },
    );
    expect(result.status).toBe(KycStatus.REVOKED);
  });

  it("does not revoke a submission that has not been approved", async () => {
    prisma.kycSubmission.findUnique.mockResolvedValueOnce({
      ...approvedSubmission,
      status: KycStatus.PENDING,
    });

    await expect(service.revoke("submission-1", "admin-1")).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it("reports revoked submissions as unverified based on the latest KYC status", async () => {
    prisma.kycSubmission.findFirst.mockResolvedValue({
      status: KycStatus.REVOKED,
      adminNotes: "Fraudulent document",
      reviewedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      service.getVerificationStatus("instructor-1"),
    ).resolves.toEqual({
      isVerified: false,
      status: KycStatus.REVOKED,
      adminNotes: "Fraudulent document",
      reviewedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("synchronizes the user verification projection from the canonical latest KYC status on approval", async () => {
    prisma.kycSubmission.findUnique.mockResolvedValueOnce({
      ...approvedSubmission,
      status: KycStatus.PENDING,
    });

    await service.review("submission-1", "admin-1", {
      status: KycStatus.APPROVED,
    });

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: "instructor-1" },
      data: { isVerified: true },
    });
  });
});
