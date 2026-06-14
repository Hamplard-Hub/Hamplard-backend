import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationType } from '@prisma/client';

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
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private lastProcessedLedger = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly courses: CoursesService,
  ) {}

  async onModuleInit() {
    try {
      const latest = await this.stellar.getLatestLedger();
      this.lastProcessedLedger = Math.max(1, latest - 10);
      this.logger.log(`Event poller initialised at ledger ${this.lastProcessedLedger}`);
    } catch {
      this.lastProcessedLedger = 1;
      this.logger.warn('Could not fetch latest ledger on init');
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollEvents() {
    try {
      const events = await this.stellar.fetchContractEvents(this.lastProcessedLedger);
      if (!events.length) return;

      this.logger.log(`Processing ${events.length} chain event(s)`);

      for (const event of events) {
        await this.processEvent(event);
        this.lastProcessedLedger = Math.max(this.lastProcessedLedger, event.ledger + 1);
      }
    } catch (error) {
      this.logger.error('Event polling failed', error.message);
    }
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
