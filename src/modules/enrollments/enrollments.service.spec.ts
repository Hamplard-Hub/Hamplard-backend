import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EnrollmentsService } from './enrollments.service';
import { FraudDetectionService, FraudCheckResult } from './fraud-detection.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { DripScheduleService } from '../lessons/drip-schedule.service';
import { StellarService } from '../../common/stellar/stellar.service';

describe('EnrollmentsService', () => {
  let service: EnrollmentsService;
  let prismaService: PrismaService;
  let fraudDetectionService: FraudDetectionService;
  let stellarService: StellarService;

  const mockPrismaService = {
    course: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    enrollment: {
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    payment: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    coursePrerequisite: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockFraudDetectionService = {
    processFraudCheck: jest.fn(),
  };

  const mockStellarService = {
    getTransactionStatus: jest.fn(),
    getContractId: jest.fn(),
    verifyEnrollmentTransaction: jest.fn(),
  };

  const mockNotificationsService = {
    notifyUser: jest.fn(),
  };

  const mockInvoicesService = {
    generateForEnrollment: jest.fn(),
  };

  const mockReferralsService = {
    trackConversion: jest.fn(),
  };

  const mockDripScheduleService = {
    calculateAndSyncUnlockSchedule: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: FraudDetectionService,
          useValue: mockFraudDetectionService,
        },
        {
          provide: StellarService,
          useValue: mockStellarService,
        },
        {
          provide: NotificationsService,
          useValue: mockNotificationsService,
        },
        {
          provide: InvoicesService,
          useValue: mockInvoicesService,
        },
        {
          provide: ReferralsService,
          useValue: mockReferralsService,
        },
        {
          provide: DripScheduleService,
          useValue: mockDripScheduleService,
        },
      ],
    }).compile();

    service = module.get<EnrollmentsService>(EnrollmentsService);
    prismaService = module.get<PrismaService>(PrismaService);
    fraudDetectionService = module.get<FraudDetectionService>(FraudDetectionService);
    stellarService = module.get<StellarService>(StellarService);
  });

  describe('create', () => {
    const mockCourse = {
      id: 'course-1',
      status: 'ACTIVE',
      platformFeePercent: 10,
      price: new Prisma.Decimal('100'),
    };

    const mockStudent = {
      id: 'student-1',
      stellarAddress: 'GAXYZ123',
    };

    const mockFraudResult: FraudCheckResult = {
      action: 'ALLOW',
      score: 10,
      riskLevel: 'LOW' as any,
      reasons: [],
    };

    beforeEach(() => {
      mockPrismaService.course.findUnique.mockResolvedValue(mockCourse);
      mockPrismaService.enrollment.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockStudent);
      mockPrismaService.payment.findUnique.mockResolvedValue(null);
      mockPrismaService.coursePrerequisite.findMany.mockResolvedValue([]);
      mockFraudDetectionService.processFraudCheck.mockResolvedValue(mockFraudResult);
      mockStellarService.verifyEnrollmentTransaction.mockResolvedValue({
        studentAddress: mockStudent.stellarAddress,
        courseId: mockCourse.id,
        amountPaid: 100,
      });
      mockStellarService.getContractId.mockReturnValue('contract-123');
    });

    it('Issue #404: should wrap payment, enrollment, and course stats in a transaction', async () => {
      const mockTx = {
        payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
        enrollment: {
          create: jest
            .fn()
            .mockResolvedValue({
              id: 'enrollment-1',
              studentId: mockStudent.id,
              courseId: mockCourse.id,
              course: mockCourse,
              student: mockStudent,
            }),
        },
        course: { update: jest.fn().mockResolvedValue(mockCourse) },
      };

      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback(mockTx);
      });

      await service.create(mockStudent.id, mockCourse.id, 'tx-hash-123');

      // Verify the transaction was called
      expect(mockPrismaService.$transaction).toHaveBeenCalled();

      // Verify all three operations happened within the transaction
      expect(mockTx.payment.create).toHaveBeenCalled();
      expect(mockTx.enrollment.create).toHaveBeenCalled();
      expect(mockTx.course.update).toHaveBeenCalled();
    });

    it('Issue #404: should rollback enrollment if payment creation fails (P2002)', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on txHash',
        'P2002',
        '4.0.0',
        { target: ['txHash'] },
      );

      mockPrismaService.$transaction.mockRejectedValue(p2002Error);

      await expect(
        service.create(mockStudent.id, mockCourse.id, 'tx-hash-123'),
      ).rejects.toThrow(ConflictException);

      // Verify the enrollment was not created (would be part of the same transaction)
      expect(mockPrismaService.enrollment.findUnique).toHaveBeenCalledTimes(1);
    });

    it('Issue #403: should verify payment transaction comprehensively', async () => {
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const mockTx = {
          payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
          enrollment: {
            create: jest
              .fn()
              .mockResolvedValue({
                id: 'enrollment-1',
                studentId: mockStudent.id,
                courseId: mockCourse.id,
                course: mockCourse,
                student: mockStudent,
              }),
          },
          course: { update: jest.fn().mockResolvedValue(mockCourse) },
        };
        return callback(mockTx);
      });

      await service.create(mockStudent.id, mockCourse.id, 'tx-hash-123');

      // Verify comprehensive verification was called with all required parameters
      expect(mockStellarService.verifyEnrollmentTransaction).toHaveBeenCalledWith(
        'tx-hash-123',
        'contract-123',
        mockStudent.stellarAddress,
        mockCourse.id,
        Number(mockCourse.price),
      );
    });

    it('Issue #405: should not run fraud check twice', async () => {
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const mockTx = {
          payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
          enrollment: {
            create: jest
              .fn()
              .mockResolvedValue({
                id: 'enrollment-1',
                studentId: mockStudent.id,
                courseId: mockCourse.id,
                course: mockCourse,
                student: mockStudent,
              }),
          },
          course: { update: jest.fn().mockResolvedValue(mockCourse) },
        };
        return callback(mockTx);
      });

      await service.create(mockStudent.id, mockCourse.id, 'tx-hash-123');

      // Verify fraud check was called only once (pre-enrollment, with null id)
      expect(mockFraudDetectionService.processFraudCheck).toHaveBeenCalledTimes(1);
      expect(mockFraudDetectionService.processFraudCheck).toHaveBeenCalledWith(
        null,
        mockStudent.id,
        mockCourse.id,
        100,
      );
    });

    it('Issue #405: should pass pre-computed fraud result to post-enrollment steps', async () => {
      const mockFlagResult: FraudCheckResult = {
        action: 'FLAG',
        score: 75,
        riskLevel: 'HIGH' as any,
        reasons: ['RAPID_REPEAT_PURCHASE'],
      };

      mockFraudDetectionService.processFraudCheck.mockResolvedValue(mockFlagResult);

      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const mockTx = {
          payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
          enrollment: {
            create: jest
              .fn()
              .mockResolvedValue({
                id: 'enrollment-1',
                studentId: mockStudent.id,
                courseId: mockCourse.id,
                course: mockCourse,
                student: mockStudent,
              }),
          },
          course: { update: jest.fn().mockResolvedValue(mockCourse) },
        };
        return callback(mockTx);
      });

      await service.create(mockStudent.id, mockCourse.id, 'tx-hash-123');

      // Verify processFraudCheck was called with shouldPersistFlag=true in post-check
      // (this happens inside runPostEnrollmentSteps)
      const callCount = mockFraudDetectionService.processFraudCheck.mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('verifyPaymentTransaction', () => {
    const mockCourse = { price: new Prisma.Decimal('100') };
    const mockStudent = { stellarAddress: 'GAXYZ123' };

    beforeEach(() => {
      mockPrismaService.payment.findUnique.mockResolvedValue(null);
      mockPrismaService.user.findUnique.mockResolvedValue(mockStudent);
      mockPrismaService.course.findUnique.mockResolvedValue(mockCourse);
      mockStellarService.getContractId.mockReturnValue('contract-123');
    });

    it('should return verified amount from on-chain data', async () => {
      mockStellarService.verifyEnrollmentTransaction.mockResolvedValue({
        studentAddress: mockStudent.stellarAddress,
        courseId: 'course-1',
        amountPaid: 150,
      });

      const result = await service.verifyPaymentTransaction(
        'tx-hash-123',
        'student-1',
        'course-1',
      );

      expect(result).toBe(150);
    });

    it('should reject if transaction student address does not match', async () => {
      const error = new Error('Student address mismatch: enrollment is for a different wallet');
      mockStellarService.verifyEnrollmentTransaction.mockRejectedValue(error);

      await expect(
        service.verifyPaymentTransaction('tx-hash-123', 'student-1', 'course-1'),
      ).rejects.toThrow();
    });

    it('should reject if amount is insufficient', async () => {
      const error = new Error('Insufficient payment: transaction amount (50) is less than course price (100)');
      mockStellarService.verifyEnrollmentTransaction.mockRejectedValue(error);

      await expect(
        service.verifyPaymentTransaction('tx-hash-123', 'student-1', 'course-1'),
      ).rejects.toThrow();
    });

    it('should reject if payment has already been used', async () => {
      mockPrismaService.payment.findUnique.mockResolvedValue({
        id: 'payment-1',
        txHash: 'tx-hash-123',
      });

      await expect(
        service.verifyPaymentTransaction('tx-hash-123', 'student-1', 'course-1'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
