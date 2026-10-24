import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { FraudDetectionService } from '../enrollments/fraud-detection.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { DripScheduleService } from '../lessons/drip-schedule.service';
import { EventsService } from './events.service';

/**
 * Issue #231 — an enrollment registered via POST /enrollments followed by the
 * on-chain `student_enrolled` event must produce exactly one enrollment row
 * and a single totalEnrollments increment.
 */
describe('Enrollment stats deduplication across API and chain paths (Issue #231)', () => {
  let enrollments: EnrollmentsService;
  let events: EventsService;

  const COURSE_ID = 'COURSE-TAILORING-001';
  const STUDENT = { id: 'student-1', stellarAddress: 'GSTUDENT', name: 'Jane' };

  // Minimal in-memory database shared by both services.
  let db: {
    users: Array<{ id: string; stellarAddress: string; name: string }>;
    courses: Array<Record<string, any>>;
    enrollments: Array<Record<string, any>>;
  };

  const applyIncrements = (row: Record<string, any>, data: Record<string, any>) => {
    for (const [field, value] of Object.entries(data)) {
      row[field] =
        value && typeof value === 'object' && 'increment' in value
          ? Number(row[field] ?? 0) + Number(value.increment)
          : value;
    }
  };

  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        db.users.find((u) =>
          where.stellarAddress ? u.stellarAddress === where.stellarAddress : u.id === where.id,
        ) ?? null,
      ),
    },
    course: {
      findUnique: jest.fn(async ({ where }: any) => db.courses.find((c) => c.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = db.courses.find((c) => c.id === where.id);
        applyIncrements(row!, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = db.courses.filter((c) => c.id === where.id);
        rows.forEach((row) => applyIncrements(row, data));
        return { count: rows.length };
      }),
    },
    enrollment: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { studentId, courseId } = where.studentId_courseId;
        return db.enrollments.find((e) => e.studentId === studentId && e.courseId === courseId) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `enroll-${db.enrollments.length + 1}`, status: 'ACTIVE', ...data };
        db.enrollments.push(row);
        return {
          ...row,
          course: db.courses.find((c) => c.id === data.courseId),
          student: db.users.find((u) => u.id === data.studentId),
        };
      }),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'pay-1', ...data })),
    },
    coursePrerequisite: { findMany: jest.fn().mockResolvedValue([]) },
    chainEvent: { create: jest.fn().mockResolvedValue({}) },
    eventPollerCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const stellar = {
    getLatestLedger: jest.fn().mockResolvedValue(100),
    fetchContractEvents: jest.fn(),
    getTransactionStatus: jest.fn().mockResolvedValue({ successful: true, status: 'SUCCESS' }),
  };

  const studentEnrolledEvent = (ledger: number) => ({
    ledger,
    txHash: 'tx-enroll',
    topic: ['student_enrolled'],
    value: [COURSE_ID, STUDENT.stellarAddress, 50],
  });

  beforeEach(async () => {
    db = {
      users: [STUDENT, { id: 'instructor-1', stellarAddress: 'GINSTRUCTOR', name: 'Inst' }],
      courses: [{
        id: COURSE_ID,
        title: 'Professional Tailoring',
        instructorAddress: 'GINSTRUCTOR',
        status: 'ACTIVE',
        totalEnrollments: 0,
        totalRevenue: 0,
      }],
      enrollments: [],
    };
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StellarService, useValue: stellar },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn().mockResolvedValue({}) } },
        { provide: CoursesService, useValue: {} },
        {
          provide: FraudDetectionService,
          useValue: {
            processFraudCheck: jest.fn().mockResolvedValue({ action: 'ALLOW', score: 0, reasons: [] }),
          },
        },
        { provide: InvoicesService, useValue: { generateForEnrollment: jest.fn().mockResolvedValue({}) } },
        { provide: ReferralsService, useValue: { trackConversion: jest.fn().mockResolvedValue({}) } },
        {
          provide: DripScheduleService,
          useValue: { calculateAndSyncUnlockSchedule: jest.fn().mockResolvedValue({}) },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: SchedulerRegistry,
          useValue: { doesExist: jest.fn(), addInterval: jest.fn(), deleteInterval: jest.fn() },
        },
      ],
    }).compile();

    enrollments = module.get(EnrollmentsService);
    events = module.get(EventsService);
  });

  it('counts an API enrollment once even after the student_enrolled event is processed', async () => {
    await enrollments.create(STUDENT.id, COURSE_ID, 'tx-enroll', 50);

    stellar.fetchContractEvents.mockResolvedValueOnce([studentEnrolledEvent(105)]);
    await events.pollEvents();

    expect(db.enrollments).toHaveLength(1);
    expect(db.courses[0].totalEnrollments).toBe(1);
    expect(db.courses[0].totalEnrollments).toBe(db.enrollments.length);
  });

  it('does not double count when the same event is replayed', async () => {
    await enrollments.create(STUDENT.id, COURSE_ID, 'tx-enroll', 50);

    stellar.fetchContractEvents
      .mockResolvedValueOnce([studentEnrolledEvent(105)])
      .mockResolvedValueOnce([studentEnrolledEvent(105)]);
    await events.pollEvents();
    await events.pollEvents();

    expect(db.enrollments).toHaveLength(1);
    expect(db.courses[0].totalEnrollments).toBe(1);
  });

  it('counts exactly once when the chain event arrives before the API registration', async () => {
    stellar.fetchContractEvents.mockResolvedValueOnce([studentEnrolledEvent(105)]);
    await events.pollEvents();

    expect(db.courses[0].totalEnrollments).toBe(0);

    await enrollments.create(STUDENT.id, COURSE_ID, 'tx-enroll', 50);

    expect(db.enrollments).toHaveLength(1);
    expect(db.courses[0].totalEnrollments).toBe(1);
  });

  it('never increments stats from the chain path for an unknown wallet', async () => {
    stellar.fetchContractEvents.mockResolvedValueOnce([
      { ...studentEnrolledEvent(106), value: [COURSE_ID, 'GUNKNOWN', 50] },
    ]);
    await events.pollEvents();

    expect(prisma.course.updateMany).not.toHaveBeenCalled();
    expect(prisma.course.update).not.toHaveBeenCalled();
    expect(db.courses[0].totalEnrollments).toBe(0);
  });
});
