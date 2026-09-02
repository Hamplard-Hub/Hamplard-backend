import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationType } from '@prisma/client';

/** Fixed primary key for the singleton poller checkpoint row. */
export const EVENT_POLLER_CHECKPOINT_KEY = 'stellar-event-poller';

/** Number of ledgers to rewind behind the chain tip on a cold start. */
const COLD_START_LOOKBACK = 10;

export interface CheckpointStatus {
  key: string;
  /** Ledger the running process will poll from next. */
  lastProcessedLedger: number;
  /** Ledger currently persisted in the database (null if never written). */
  persistedLedger: number | null;
  lastPolledAt: Date | null;
  /** How the poller obtained its starting ledger on the last boot. */
  resumedFromCheckpoint: boolean;
  consecutiveWriteFailures: number;
  lastWriteError: string | null;
  /** true when the last checkpoint write succeeded. */
  healthy: boolean;
}

/**
 * EventsService
 *
 * Polls Stellar RPC every 5 seconds for Hamplard contract events:
 *
 *   - course_registered    → log, backend already has the record from POST /courses
 *   - course_approved      → update course status in DB
 *   - student_enrolled     → update enrollment + course stats (safety net)
 *   - course_completed     → trigger certificate issuance flow
 *   - certificate_issued   → update DB txHash, notify student
 *   - certificate_revoked  → update DB flag
 *   - course_paused        → update course status
 *   - course_archived      → update course status
 *
 * The last processed Stellar ledger is persisted to the `event_poller_checkpoints`
 * table after every poll. On boot the service resumes from that checkpoint so a
 * restart or crash does not skip events that landed while the process was down.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private lastProcessedLedger = 0;

  // Checkpoint bookkeeping (in-memory mirror of the DB row).
  private resumedFromCheckpoint = false;
  private consecutiveWriteFailures = 0;
  private lastWriteError: string | null = null;
  private lastPolledAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly courses: CoursesService,
  ) {}

  async onModuleInit() {
    const checkpoint = await this.loadCheckpoint();
    let latestLedger: number | null = null;
    try {
      latestLedger = await this.stellar.getLatestLedger();
    } catch {
      this.logger.warn('Could not fetch latest ledger on init');
    }

    if (checkpoint && checkpoint.lastProcessedLedger > 0) {
      // Guard against a corrupt / stale checkpoint that points past the chain
      // tip (e.g. restored from another network) — fall back to a cold start.
      if (latestLedger !== null && checkpoint.lastProcessedLedger > latestLedger + 1) {
        this.lastProcessedLedger = Math.max(1, latestLedger - COLD_START_LOOKBACK);
        this.resumedFromCheckpoint = false;
        this.logger.warn(
          `Persisted checkpoint ledger ${checkpoint.lastProcessedLedger} is ahead of ` +
            `chain tip ${latestLedger}; ignoring it and restarting near the tip at ` +
            `${this.lastProcessedLedger}`,
        );
      } else {
        this.lastProcessedLedger = checkpoint.lastProcessedLedger;
        this.resumedFromCheckpoint = true;
        this.logger.log(
          `Resumed event poller from persisted ledger ${this.lastProcessedLedger}`,
        );
      }
      return;
    }

    // Cold start — no usable checkpoint yet.
    this.lastProcessedLedger =
      latestLedger !== null ? Math.max(1, latestLedger - COLD_START_LOOKBACK) : 1;
    this.resumedFromCheckpoint = false;
    this.logger.log(`Event poller initialised at ledger ${this.lastProcessedLedger}`);
    await this.persistCheckpoint();
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollEvents() {
    try {
      const events = await this.stellar.fetchContractEvents(this.lastProcessedLedger);

      if (events.length) {
        this.logger.log(`Processing ${events.length} chain event(s)`);

        for (const event of events) {
          await this.processEvent(event);
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, event.ledger + 1);
        }
      }
    } catch (error) {
      this.logger.error('Event polling failed', error.message);
    } finally {
      // Persist progress even when a poll finds nothing — a checkpoint write
      // failure is logged but never allowed to stop the poll loop.
      this.lastPolledAt = new Date();
      await this.persistCheckpoint();
    }
  }

  // ----------------------------------------------------------
  // CHECKPOINT PERSISTENCE (Issue #80 — crash recovery)
  // ----------------------------------------------------------

  /** Read the persisted checkpoint row, tolerating any DB error. */
  private async loadCheckpoint() {
    try {
      return await this.prisma.eventPollerCheckpoint.findUnique({
        where: { key: EVENT_POLLER_CHECKPOINT_KEY },
      });
    } catch (error) {
      this.logger.error('Could not read event poller checkpoint', error.message);
      return null;
    }
  }

  /**
   * Write the current ledger to the checkpoint row. Best-effort: a failure
   * increments the failure counter and is surfaced via the health endpoint,
   * but is swallowed so polling keeps running.
   */
  private async persistCheckpoint(): Promise<void> {
    try {
      await this.prisma.eventPollerCheckpoint.upsert({
        where: { key: EVENT_POLLER_CHECKPOINT_KEY },
        create: {
          key: EVENT_POLLER_CHECKPOINT_KEY,
          lastProcessedLedger: this.lastProcessedLedger,
          lastPolledAt: this.lastPolledAt,
        },
        update: {
          lastProcessedLedger: this.lastProcessedLedger,
          lastPolledAt: this.lastPolledAt,
          lastWriteError: null,
          consecutiveWriteFailures: 0,
        },
      });
      this.consecutiveWriteFailures = 0;
      this.lastWriteError = null;
    } catch (error) {
      this.consecutiveWriteFailures += 1;
      this.lastWriteError = error?.message ?? String(error);
      this.logger.error(
        `Failed to persist ledger checkpoint (consecutive failure ` +
          `#${this.consecutiveWriteFailures}); polling continues`,
        this.lastWriteError,
      );
      // Try to record the failure on the row itself, but do not care if this
      // also fails — the poll loop must not be blocked by checkpoint I/O.
      try {
        await this.prisma.eventPollerCheckpoint.updateMany({
          where: { key: EVENT_POLLER_CHECKPOINT_KEY },
          data: {
            lastWriteError: this.lastWriteError.slice(0, 500),
            consecutiveWriteFailures: this.consecutiveWriteFailures,
          },
        });
      } catch {
        /* already logged above */
      }
    }
  }

  /** Current checkpoint state, exposed through GET /health/checkpoint. */
  async getCheckpointStatus(): Promise<CheckpointStatus> {
    let persisted: Awaited<ReturnType<typeof this.loadCheckpoint>> = null;
    try {
      persisted = await this.prisma.eventPollerCheckpoint.findUnique({
        where: { key: EVENT_POLLER_CHECKPOINT_KEY },
      });
    } catch (error) {
      this.logger.error('Could not read checkpoint for health report', error.message);
    }

    return {
      key: EVENT_POLLER_CHECKPOINT_KEY,
      lastProcessedLedger: this.lastProcessedLedger,
      persistedLedger: persisted?.lastProcessedLedger ?? null,
      lastPolledAt: persisted?.lastPolledAt ?? this.lastPolledAt,
      resumedFromCheckpoint: this.resumedFromCheckpoint,
      consecutiveWriteFailures: this.consecutiveWriteFailures,
      lastWriteError: this.lastWriteError,
      healthy: this.consecutiveWriteFailures === 0,
    };
  }

  private async processEvent(event: any) {
    const eventName = this.extractEventName(event);
    const payload   = this.extractPayload(event);

    await this.saveRawEvent(eventName, event, payload);

    switch (eventName) {
      case 'course_registered':    return this.handleCourseRegistered(payload);
      case 'course_approved':      return this.handleCourseApproved(payload);
      case 'course_paused':        return this.handleCoursePaused(payload);
      case 'course_archived':      return this.handleCourseArchived(payload);
      case 'student_enrolled':     return this.handleStudentEnrolled(payload);
      case 'course_completed':     return this.handleCourseCompleted(payload);
      case 'certificate_issued':   return this.handleCertificateIssued(payload);
      case 'certificate_revoked':  return this.handleCertificateRevoked(payload);
      default: this.logger.warn(`Unknown event: ${eventName}`);
    }
  }

  // ----------------------------------------------------------
  // EVENT HANDLERS
  // ----------------------------------------------------------

  private async handleCourseRegistered(payload: any) {
    const courseId = String(payload);
    this.logger.log(`Course registered on-chain: ${courseId}`);
    // No DB update needed — course was created via POST /courses already
  }

  private async handleCourseApproved(payload: any) {
    const courseId = String(payload);
    this.logger.log(`Course approved on-chain: ${courseId}`);
    // Sync status — safety net for cases where admin called approve_course
    // on-chain without going through the backend endpoint
    try {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { status: 'ACTIVE', approvedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(`Could not sync course approval for ${courseId}: ${e.message}`);
    }
  }

  private async handleCoursePaused(payload: any) {
    const courseId = String(payload);
    await this.prisma.course.updateMany({
      where: { id: courseId },
      data: { status: 'PAUSED' },
    });
  }

  private async handleCourseArchived(payload: any) {
    const courseId = String(payload);
    await this.prisma.course.updateMany({
      where: { id: courseId },
      data: { status: 'ARCHIVED' },
    });
  }

  private async handleStudentEnrolled(payload: any) {
    // Payload: (course_id, student_address, amount_paid)
    const [courseId, studentAddress, amountPaid] = Array.isArray(payload)
      ? payload
      : [payload, null, null];

    this.logger.log(`Student enrolled on-chain: ${studentAddress} → ${courseId}`);
    // Enrollment is primarily registered via POST /enrollments from the frontend.
    // This handler updates course stats as a safety net.
    if (courseId) {
      await this.prisma.course.updateMany({
        where: { id: String(courseId) },
        data: { totalEnrollments: { increment: 1 } },
      });
    }
  }

  private async handleCourseCompleted(payload: any) {
    // Payload: (course_id, student_address)
    const [courseId, studentAddress] = Array.isArray(payload) ? payload : [payload, null];
    this.logger.log(`Course completed on-chain: ${studentAddress} completed ${courseId}`);

    if (!studentAddress) return;

    // Find the student and update enrollment status
    const student = await this.prisma.user.findUnique({
      where: { stellarAddress: String(studentAddress) },
    });
    if (!student) return;

    await this.prisma.enrollment.updateMany({
      where: { studentId: student.id, courseId: String(courseId) },
      data: { status: 'COMPLETED', completedAt: new Date(), progressPercent: 100 },
    });

    await this.notifications.notifyUser(
      student.id,
      NotificationType.COURSE_COMPLETED,
      'Course completed! 🎉',
      `You have completed the course. Your certificate will be issued shortly.`,
      { courseId },
    );
  }

  private async handleCertificateIssued(payload: any) {
    // Payload: (certificate_id, student_address, course_id)
    const [certificateId, studentAddress, courseId] = Array.isArray(payload)
      ? payload
      : [payload, null, null];

    this.logger.log(`Certificate issued on-chain: ${certificateId}`);

    if (studentAddress) {
      const student = await this.prisma.user.findUnique({
        where: { stellarAddress: String(studentAddress) },
      });
      if (student) {
        await this.notifications.notifyUser(
          student.id,
          NotificationType.CERTIFICATE_ISSUED,
          '🎓 Your certificate is on-chain!',
          `Your certificate (ID: ${certificateId}) has been permanently recorded on the Stellar blockchain.`,
          { certificateId, courseId },
        );
      }
    }
  }

  private async handleCertificateRevoked(payload: any) {
    const certificateId = String(payload);
    this.logger.log(`Certificate revoked on-chain: ${certificateId}`);
    await this.prisma.certificate.updateMany({
      where: { id: certificateId },
      data: { isRevoked: true },
    });
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private extractEventName(event: any): string {
    try { return event.topic?.[0]?.toString() ?? 'unknown'; }
    catch { return 'unknown'; }
  }

  private extractPayload(event: any): any {
    try { return event.value ? JSON.parse(JSON.stringify(event.value)) : null; }
    catch { return null; }
  }

  private async saveRawEvent(eventName: string, event: any, payload: any) {
    try {
      const courseId = typeof payload === 'string' ? payload :
        Array.isArray(payload) && typeof payload[0] === 'string' ? payload[0] : null;

      await this.prisma.chainEvent.create({
        data: {
          eventName,
          ledger:   event.ledger ?? 0,
          txHash:   event.txHash ?? '',
          payload:  payload ?? {},
          courseId: courseId || undefined,
        },
      });
    } catch (error) {
      this.logger.error('Failed to save raw event', error.message);
    }
  }

  async findAll(courseId?: string, page = 1, limit = 20) {
    const where = courseId ? { courseId } : {};
    const [events, total] = await this.prisma.$transaction([
      this.prisma.chainEvent.findMany({
        where,
        orderBy: { ledger: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.chainEvent.count({ where }),
    ]);
    return { data: events, meta: { total, page, limit } };
  }
}
