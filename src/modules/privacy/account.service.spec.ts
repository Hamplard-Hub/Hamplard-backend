import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountService, deletedWalletPlaceholder } from './account.service';

const USER_ID = 'user-1';
const OLD_ADDRESS = 'GOLDWALLETADDRESS';

describe('AccountService', () => {
  let service: AccountService;
  let tx: any;
  let prisma: any;
  let cache: { del: jest.Mock };

  const model = () => ({
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  });

  beforeEach(() => {
    tx = {
      user: model(),
      refreshToken: model(),
      session: model(),
      phoneOtp: model(),
      notificationDeviceToken: model(),
      notificationPreference: model(),
      notificationDigestPreference: model(),
      notification: model(),
      wishlistItem: model(),
      courseDraft: model(),
      dataExportJob: model(),
      smsMessage: model(),
      liveSessionRsvp: model(),
      payoutSchedule: model(),
      assignmentSubmission: model(),
      courseReview: model(),
      question: model(),
      answer: model(),
      discussionComment: model(),
      abuseReport: model(),
      kycSubmission: model(),
      certificate: model(),
      dispute: model(),
      refund: model(),
      analyticsEvent: model(),
      payout: model(),
      liveSession: model(),
      adminAuditLog: model(),
    };
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    cache = { del: jest.fn().mockResolvedValue(undefined) };
    service = new AccountService(prisma, cache as any);
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      stellarAddress: OLD_ADDRESS,
      deactivatedAt: null,
      deletedAt: null,
    });
  });

  describe('deactivate()', () => {
    it('marks the account deactivated and revokes sessions and refresh tokens', async () => {
      const result = await service.deactivate(USER_ID);

      expect(result.deactivated).toBe(true);
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { deactivatedAt: expect.any(Date) },
      });
      expect(tx.session.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('drops the cached JWT user entry so the lockout is immediate', async () => {
      await service.deactivate(USER_ID);
      expect(cache.del).toHaveBeenCalledWith(`jwt:user:${USER_ID}`);
    });

    it('rejects an already deactivated account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deactivatedAt: new Date(), deletedAt: null });
      await expect(service.deactivate(USER_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats a deleted or missing account as not found', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: new Date() });
      await expect(service.deactivate(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.deactivate(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reactivate()', () => {
    it('clears deactivatedAt on a deactivated account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deactivatedAt: new Date(), deletedAt: null });

      await expect(service.reactivate(USER_ID)).resolves.toEqual({ reactivated: true });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { deactivatedAt: null },
      });
      expect(cache.del).toHaveBeenCalledWith(`jwt:user:${USER_ID}`);
    });

    it('rejects an account that is not deactivated', async () => {
      await expect(service.reactivate(USER_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('cannot reactivate a deleted account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deactivatedAt: null, deletedAt: new Date() });
      await expect(service.reactivate(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteAccount()', () => {
    it('runs everything in one transaction', async () => {
      await service.deleteAccount(USER_ID);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('removes every PII field and credential from the user row', async () => {
      await service.deleteAccount(USER_ID);

      const { where, data } = tx.user.update.mock.calls[0][0];
      expect(where).toEqual({ id: USER_ID });
      expect(data).toEqual(
        expect.objectContaining({
          stellarAddress: deletedWalletPlaceholder(USER_ID),
          googleId: null,
          email: null,
          name: null,
          bio: null,
          avatarUrl: null,
          phoneNumber: null,
          phoneCountryCode: null,
          isPhoneVerified: false,
          phoneVerifiedAt: null,
          banReason: null,
          suspensionReason: null,
          twoFactorSecret: null,
          twoFactorEnabled: false,
          twoFactorRecoveryCodes: [],
          deactivatedAt: null,
          deletedAt: expect.any(Date),
        }),
      );
      // the real wallet address must not survive anywhere on the row
      expect(JSON.stringify(data)).not.toContain(OLD_ADDRESS);
    });

    it('deletes sessions, refresh tokens and other personal records', async () => {
      await service.deleteAccount(USER_ID);

      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.phoneOtp.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.notification.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.notificationDeviceToken.deleteMany).toHaveBeenCalled();
      expect(tx.smsMessage.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.dataExportJob.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
      expect(tx.payoutSchedule.deleteMany).toHaveBeenCalledWith({ where: { instructorId: USER_ID } });
    });

    it('scrubs free text on records it keeps', async () => {
      await service.deleteAccount(USER_ID);

      expect(tx.assignmentSubmission.updateMany).toHaveBeenCalledWith({
        where: { studentId: USER_ID },
        data: { notes: null, submissionUrl: null, feedback: null },
      });
      expect(tx.kycSubmission.updateMany).toHaveBeenCalledWith({
        where: { instructorId: USER_ID },
        data: { documentUrl: '[deleted]', additionalUrl: null, adminNotes: null },
      });
      expect(tx.discussionComment.updateMany).toHaveBeenCalledWith({
        where: { authorId: USER_ID },
        data: { content: '[deleted]' },
      });
      expect(tx.analyticsEvent.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: expect.objectContaining({ userId: null, ipAddress: null, properties: Prisma.DbNull }),
      });
    });

    it('preserves financial records: never deletes or voids enrollments, payments, invoices, refunds, payouts', async () => {
      // None of these delegates are even available on the transaction client for
      // deletion; refunds and payouts are only touched to redact free text.
      expect(tx.enrollment).toBeUndefined();
      expect(tx.payment).toBeUndefined();
      expect(tx.invoice).toBeUndefined();
      expect(tx.bundleEnrollment).toBeUndefined();

      await service.deleteAccount(USER_ID);

      expect(tx.refund.deleteMany).not.toHaveBeenCalled();
      expect(tx.payout.deleteMany).not.toHaveBeenCalled();
      expect(tx.refund.updateMany).toHaveBeenCalledWith({
        where: { studentId: USER_ID },
        data: { reason: '[deleted]' },
      });
      expect(tx.payout.updateMany).toHaveBeenCalledWith({
        where: { instructorId: USER_ID },
        data: { notes: null, scheduleId: null },
      });
      // the user row is retained (update, never delete) so references stay valid
      expect((tx.user as any).delete).toBeUndefined();
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });

    it('replaces non-FK copies of the wallet address', async () => {
      await service.deleteAccount(USER_ID);

      expect(tx.liveSession.updateMany).toHaveBeenCalledWith({
        where: { instructorAddress: OLD_ADDRESS },
        data: { instructorAddress: deletedWalletPlaceholder(USER_ID) },
      });
      expect(tx.certificate.updateMany).toHaveBeenCalledWith({
        where: { instructorAddress: OLD_ADDRESS },
        data: { instructorAddress: deletedWalletPlaceholder(USER_ID) },
      });
    });

    it('keeps audit-log rows but strips IPs and PII metadata keys', async () => {
      tx.adminAuditLog.findMany.mockResolvedValue([
        { id: 'a1', metadata: { action: 'wallet_linked', stellarAddress: OLD_ADDRESS } },
        { id: 'a2', metadata: { note: 'no pii here' } },
        { id: 'a3', metadata: null },
      ]);

      await service.deleteAccount(USER_ID);

      expect(tx.adminAuditLog.deleteMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.updateMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        data: { ipAddress: null },
      });
      expect(tx.adminAuditLog.update).toHaveBeenCalledTimes(1);
      expect(tx.adminAuditLog.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { metadata: { action: 'wallet_linked' } },
      });
    });

    it('invalidates the cached JWT user entry', async () => {
      await service.deleteAccount(USER_ID);
      expect(cache.del).toHaveBeenCalledWith(`jwt:user:${USER_ID}`);
    });

    it('works for accounts with no wallet (Google-only)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, stellarAddress: null, deactivatedAt: null, deletedAt: null });
      await service.deleteAccount(USER_ID);
      expect(tx.liveSession.updateMany).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalled();
    });

    it('can delete a deactivated account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, stellarAddress: OLD_ADDRESS, deactivatedAt: new Date(), deletedAt: null });
      await expect(service.deleteAccount(USER_ID)).resolves.toEqual({ deleted: true, deletedAt: expect.any(Date) });
    });

    it('is not repeatable: an already deleted account is not found', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: new Date() });
      await expect(service.deleteAccount(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates a transaction failure and does not touch the cache', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      await expect(service.deleteAccount(USER_ID)).rejects.toThrow('db down');
      expect(cache.del).not.toHaveBeenCalled();
    });
  });
});
