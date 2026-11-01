import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnrollmentsService } from './enrollments.service';
import { FraudDetectionService } from './fraud-detection.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { DripScheduleService } from '../lessons/drip-schedule.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { CourseStatus, FraudFlagStatus, FraudRiskLevel } from '@prisma/client';

describe('EnrollmentsService - Fraud HOLD handling', () => {
  let service: EnrollmentsService;
  let fraudDetection: FraudDetectionService;
  let prisma: PrismaService;

  const mockPrisma = {
    enrollment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    coursePrerequisite: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    course: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    enrollmentFraudFlag: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockStellar = {
    getTransactionStatus: jest.fn().mockResolvedValue({ successful: true, status: 'SUCCESS' }),
  };

  const mockNotifications = {
    notifyUser: jest.fn().mockResolvedValue({}),
  };

  const mockInvoices = {
    generateInvoice: jest.fn().mockResolvedValue({}),
  };

  const mockReferrals = {
    processReward: jest.fn().mockResolvedValue({}),
  };

  const mockDripSchedule = {
    calculateAndSyncUnlockSchedule: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        FraudDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: InvoicesService, useValue: mockInvoices },
        { provide: ReferralsService, useValue: mockReferrals },
        { provide: DripScheduleService, useValue: mockDripSchedule },
        { provide: StellarService, useValue: mockStellar },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<EnrollmentsService>(EnrollmentsService);
    fraudDetection = module.get<FraudDetectionService>(FraudDetectionService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('persists a HELD fraud flag and throws 423 when an enrollment is blocked by fraud check', async () => {
    mockPrisma.enrollment.findUnique.mockResolvedValue(null);
    // checkPrerequisites() requires the target course to exist
    mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', title: 'Course 1', status: CourseStatus.ACTIVE });
    mockPrisma.coursePrerequisite.findMany.mockResolvedValue([]);

    const heldFlagId = 'flag-held-uuid-1';
    jest.spyOn(fraudDetection, 'processFraudCheck').mockResolvedValue({
      action: 'HOLD',
      score: 95,
      riskLevel: FraudRiskLevel.CRITICAL,
      reasons: ['HIGH_DAILY_VOLUME', 'HIGH_AMOUNT_ANOMALY'],
      flagId: heldFlagId,
    });

    let error: any;
    try {
      await service.create('student-1', 'course-1', 'fake-tx-hash', 500);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(423);
    expect(error.getResponse()).toEqual(
      expect.objectContaining({
        statusCode: 423,
        error: 'Enrollment Locked',
        riskScore: 95,
        flagId: heldFlagId,
      }),
    );
    expect(fraudDetection.processFraudCheck).toHaveBeenCalledWith(
      null,
      'student-1',
      'course-1',
      500,
    );
    expect(mockPrisma.enrollment.create).not.toHaveBeenCalled();
  });

  it('allows querying HELD fraud flags even when no enrollment exists', async () => {
    const heldFlag = {
      id: 'flag-held-uuid-1',
      enrollmentId: null,
      studentId: 'student-1',
      blockedCourseId: 'course-1',
      blockedAmountPaid: 500,
      riskScore: 95,
      riskLevel: FraudRiskLevel.CRITICAL,
      reasons: ['HIGH_DAILY_VOLUME'],
      status: FraudFlagStatus.HELD,
      enrollment: null,
      student: { id: 'student-1', name: 'John Doe', email: 'john@example.com' },
      reviewedBy: null,
    };

    mockPrisma.$transaction.mockResolvedValue([[heldFlag], 1]);

    const result = await fraudDetection.getFraudReviewQueue({
      status: FraudFlagStatus.HELD,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe(FraudFlagStatus.HELD);
    expect(result.data[0].enrollment).toBeNull();
    expect(result.data[0].blockedCourseId).toBe('course-1');
  });

  describe('searchAdmin (Issue #497)', () => {
    it('searches enrollments with filters for studentId, courseId, txHash, status', async () => {
      const mockRecord = {
        id: 'enrollment-1',
        studentId: 'student-1',
        courseId: 'course-1',
        txHash: '0xabc123',
        status: 'ACTIVE',
        amountPaid: 100,
        enrolledAt: new Date(),
        student: { id: 'student-1', name: 'Alice', email: 'alice@example.com' },
        course: { id: 'course-1', title: 'Rust Soroban', price: 100 },
      };

      mockPrisma.$transaction.mockResolvedValue([[mockRecord], 1]);

      const result = await service.searchAdmin({
        studentId: 'student-1',
        courseId: 'course-1',
        txHash: '0xabc',
        status: 'ACTIVE' as any,
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('enrollment-1');
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('paginates correctly when no filters are passed', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.searchAdmin({ page: 2, limit: 15 });

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.page).toBe(2);
      expect(result.meta.limit).toBe(15);
    });
  });
});
