import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CONTRACT_EVENT_PAGE_LIMIT, StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationType } from '@prisma/client';

/** Fixed primary key for the singleton poller checkpoint row. */
export const EVENT_POLLER_CHECKPOINT_KEY = 'stellar-event-poller';

/** Number of ledgers to rewind behind the chain tip on a cold start. */
const COLD_START_LOOKBACK = 10;

/** Max length of the persisted handler error string. */
const MAX_HANDLER_ERROR_LENGTH = 500;
/** SchedulerRegistry name of the poll interval (issue #229). */
export const EVENT_POLLER_INTERVAL_NAME = 'stellar-event-poller';

/** Poll interval used when EVENT_POLLING_INTERVAL_MS is unset or invalid. */
export const DEFAULT_EVENT_POLLING_INTERVAL_MS = 5000;

export interface CheckpointStatus {
  key: string;
  /** Ledger the running process will poll from next. */
  lastProcessedLedger: number;
  /** Token of the last event processed while a ledger range is being drained. */
  lastProcessedCursor: string | null;
  /** Ledger currently persisted in the database (null if never written). */
  persistedLedger: number | null;
  persistedCursor: string | null;
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
 * Polls Stellar RPC every EVENT_POLLING_INTERVAL_MS (default 5s) for Hamplard
 * contract events:
 *
 *   - course_registered    → log, backend already has the record from POST /courses
 *   - course_approved      → update course status in DB
 *   - student_enrolled     → reconcile with the API enrollment (no double counting)
 *   - course_completed     → trigger certificate issuance flow
 *   - certificate_issued   → update DB txHash, notify student
 *   - certificate_revoked  → update DB flag
 *   - course_paused        → update course status
 *   - course_archived      → update course status
 *
 * The event cursor is persisted after each event. Once all available pages are
 * drained, the checkpoint moves to the next ledger and clears the cursor.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private lastProcessedLedger = 0;
  private lastProcessedCursor: string | null = null;

  /** Re-entrancy guard — true while a poll is running (issue #229). */
  private isPolling = false;

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
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    await this.initCheckpoint();
    this.startPolling();
  }

  onModuleDestroy() {
    if (this.schedulerRegistry.doesExist('interval', EVENT_POLLER_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(EVENT_POLLER_INTERVAL_NAME);
    }
  }

  /** Poll interval from EVENT_POLLING_INTERVAL_MS, falling back to 5000 ms. */
  getPollingIntervalMs(): number {
    const raw = Number(this.config.get('EVENT_POLLING_INTERVAL_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EVENT_POLLING_INTERVAL_MS;
  }

  /** Registers the poll loop with SchedulerRegistry (replaces the fixed 5s @Cron). */
  private startPolling(): void {
    if (this.schedulerRegistry.doesExist('interval', EVENT_POLLER_INTERVAL_NAME)) return;

    const intervalMs = this.getPollingIntervalMs();
    const interval = setInterval(() => {
      void this.pollEvents();
    }, intervalMs);
    this.schedulerRegistry.addInterval(EVENT_POLLER_INTERVAL_NAME, interval);
    this.logger.log(`Event poller scheduled every ${intervalMs} ms`);
  }

  private async initCheckpoint() {
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
        this.lastProcessedCursor = null;
        this.resumedFromCheckpoint = false;
        this.logger.warn(
          `Persisted checkpoint ledger ${checkpoint.lastProcessedLedger} is ahead of ` +
            `chain tip ${latestLedger}; ignoring it and restarting near the tip at ` +
            `${this.lastProcessedLedger}`,
        );
      } else {
        this.lastProcessedLedger = checkpoint.lastProcessedLedger;
        this.lastProcessedCursor = checkpoint.lastProcessedCursor;
        this.resumedFromCheckpoint = true;
        this.logger.log(
          `Resumed event poller from persisted ${this.lastProcessedCursor ? 'event cursor' : `ledger ${this.lastProcessedLedger}`}`,
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

  async pollEvents() {
    // Issue #229 — a slow RPC/DB round-trip must not let ticks overlap, which
    // would process the same ledger range twice.
    if (this.isPolling) {
      this.logger.debug('Previous event poll still running; skipping this tick');
      return;
    }
    this.isPolling = true;

    try {
      // RPC rejects a start ledger beyond its current tip. A cursor already
      // identifies an event within the retained range, so it needs no check.
      if (!this.lastProcessedCursor && this.lastProcessedLedger > await this.stellar.getLatestLedger()) {
        return;
      }

      let count = 0;
      while (true) {
        const page = await this.stellar.fetchContractEvents(
          this.lastProcessedLedger,
          this.lastProcessedCursor ?? undefined,
        );
        const events = page.events ?? [];
        for (const event of events) {
          const isNew = await this.processEvent(event);
          // Only advance the checkpoint past an event once it has been
          // durably recorded; a duplicate (already-seen) event is safe to
          // skip past since its row already exists.
          if (isNew) {
            this.lastProcessedLedger = Math.max(this.lastProcessedLedger, event.ledger + 1);
          }
          if (!event.pagingToken || event.pagingToken === this.lastProcessedCursor) {
            throw new Error('RPC event has no advancing paging token');
          }
          await this.processEvent(event);
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, event.ledger + 1);
          this.lastProcessedCursor = event.pagingToken;
          // A crash in the middle of a full page must resume at this event,
          // rather than skipping the rest of its ledger.
          await this.persistCheckpoint();
          count += 1;
        }

        if (events.length < CONTRACT_EVENT_PAGE_LIMIT) {
          // The range through latestLedger has been fully scanned. Start at
          // the next ledger so an idle poller never holds an expiring cursor.
          this.lastProcessedLedger = Math.max(this.lastProcessedLedger, page.latestLedger + 1);
          this.lastProcessedCursor = null;
          break;
        }
      }
      if (count) this.logger.log(`Processed ${count} chain event(s)`);
    } catch (error) {
      this.logger.error('Event polling failed', error.message);
    } finally {
      // Persist progress even when a poll finds nothing — a checkpoint write
      // failure is logged but never allowed to stop the poll loop.
      this.lastPolledAt = new Date();
      try {
        await this.persistCheckpoint();
      } finally {
        this.isPolling = false;
      }
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
   * Write the current event position to the checkpoint row. Best-effort: a failure
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
          lastProcessedCursor: this.lastProcessedCursor,
          lastPolledAt: this.lastPolledAt,
        },
        update: {
          lastProcessedLedger: this.lastProcessedLedger,
          lastProcessedCursor: this.lastProcessedCursor,
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
        `Failed to persist event checkpoint (consecutive failure ` +
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
      lastProcessedCursor: this.lastProcessedCursor,
      persistedLedger: persisted?.lastProcessedLedger ?? null,
      persistedCursor: persisted?.lastProcessedCursor ?? null,
      lastPolledAt: persisted?.lastPolledAt ?? this.lastPolledAt,
      resumedFromCheckpoint: this.resumedFromCheckpoint,
      consecutiveWriteFailures: this.consecutiveWriteFailures,
      lastWriteError: this.lastWriteError,
      healthy: this.consecutiveWriteFailures === 0,
    };
  }

  /**
   * Persist the raw event and, if it is new, run its handler.
   *
   * Returns true when the event was newly inserted (handler was run), false
   * when it was a duplicate that was skipped.
   */
  private async processEvent(event: any): Promise<boolean> {
    const eventName = this.extractEventName(event);
    const payload   = this.extractPayload(event);

    const chainEventId = await this.saveRawEvent(eventName, event, payload);
    if (chainEventId === null) {
      // Duplicate event — already ingested and handled on a previous run.
      return false;
    }

    try {
      switch (eventName) {
        case 'course_registered':    await this.handleCourseRegistered(payload); break;
        case 'course_approved':      await this.handleCourseApproved(payload); break;
        case 'course_paused':        await this.handleCoursePaused(payload); break;
        case 'course_archived':      await this.handleCourseArchived(payload); break;
        case 'student_enrolled':     await this.handleStudentEnrolled(payload); break;
        case 'course_completed':     await this.handleCourseCompleted(payload); break;
        case 'certificate_issued':   await this.handleCertificateIssued(payload); break;
        case 'certificate_revoked':  await this.handleCertificateRevoked(payload); break;
        default: this.logger.warn(`Unknown event: ${eventName}`);
      }
      await this.markEventProcessed(chainEventId, true, null);
    } catch (error) {
      const message = error?.message ?? String(error);
      this.logger.error(`Handler for ${eventName} failed: ${message}`);
      await this.markEventProcessed(chainEventId, false, message);
    }

    return true;
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
    // Issue #231 — EnrollmentsService.create() (POST /enrollments) owns the
    // enrollment row and the totalEnrollments/totalRevenue increment. This
    // handler only reconciles, so a (student, course) pair is never counted
    // twice — including when the same event is replayed after a restart.
    if (!courseId || !studentAddress) return;

    const student = await this.prisma.user.findUnique({
      where: { stellarAddress: String(studentAddress) },
      select: { id: true },
    });
    const enrollment = student
      ? await this.prisma.enrollment.findUnique({
          where: { studentId_courseId: { studentId: student.id, courseId: String(courseId) } },
          select: { id: true },
        })
      : null;

    if (enrollment) {
      this.logger.debug(
        `Enrollment ${enrollment.id} already registered via API; skipping stat update`,
      );
      return;
    }

    // No backend record yet — POST /enrollments creates it and updates the
    // stats when it lands, so incrementing here would double count.
    this.logger.warn(
      `On-chain enrollment ${studentAddress} → ${courseId} has no backend record yet; ` +
        'awaiting API registration',
    );
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

  /**
   * Insert the raw event, skipping if it has already been seen.
   *
   * Returns the created ChainEvent id, or null when the event was a duplicate
   * (unique constraint on eventId / txHash+eventIndex).
   */
  private async saveRawEvent(
    eventName: string,
    event: any,
    payload: any,
  ): Promise<string | null> {
    try {
      const courseId = typeof payload === 'string' ? payload :
        Array.isArray(payload) && typeof payload[0] === 'string' ? payload[0] : null;

      const eventId = this.extractEventId(event);
      const txHash = event.txHash ?? '';
      const eventIndex = this.extractEventIndex(event);

      const created = await this.prisma.chainEvent.create({
        data: {
          eventName,
          ledger:   event.ledger ?? 0,
          txHash,
          eventId,
          eventIndex,
          payload:  payload ?? {},
          courseId: courseId || undefined,
        },
      });
      return created.id;
    } catch (error) {
      // P2002 = unique constraint violation → duplicate event, skip it.
      if (error?.code === 'P2002') {
        this.logger.debug(
          `Skipping duplicate chain event ${this.extractEventId(event)} ` +
            `(txHash=${event.txHash ?? ''})`,
        );
        return null;
      }
      this.logger.error('Failed to save raw event', error.message);
      return null;
    }
  }

  /** Record handler outcome on the raw event row. */
  private async markEventProcessed(
    id: string,
    processed: boolean,
    handlerError: string | null,
  ): Promise<void> {
    try {
      await this.prisma.chainEvent.update({
        where: { id },
        data: {
          processed,
          handlerError: handlerError
            ? handlerError.slice(0, MAX_HANDLER_ERROR_LENGTH)
            : null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to update processed flag for chain event ${id}`,
        error.message,
      );
    }
  }

  /**
   * Stable identifier for an RPC event. Prefers the RPC-provided id; falls
   * back to txHash + event index so older payloads still dedupe.
   */
  private extractEventId(event: any): string {
    if (event?.id) return String(event.id);
    const txHash = event?.txHash ?? '';
    const index = this.extractEventIndex(event);
    return `${txHash}:${index}`;
  }

  private extractEventIndex(event: any): number {
    if (typeof event?.eventIndex === 'number') return event.eventIndex;
    if (typeof event?.index === 'number') return event.index;
    if (typeof event?.pagingToken === 'string') {
      const parsed = Number(event.pagingToken);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
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
