import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { LiveSessionStatus } from '@prisma/client';

@Injectable()
export class LiveSessionsService {
  private readonly logger = new Logger(LiveSessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Schedule a new live session for a course.
   */
  async scheduleSession(user: any, dto: CreateSessionDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      include: { instructor: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    const instructorAddr = user.stellarAddress || user.address || course.instructorAddress;
    if (
      course.instructor.id !== user.id &&
      course.instructorAddress !== user.stellarAddress
    ) {
      throw new ForbiddenException('Only the course instructor can schedule live sessions');
    }

    const scheduledDate = new Date(dto.scheduledAt);
    const durationMins = dto.durationMinutes ?? 60;
    const endDate = new Date(scheduledDate.getTime() + durationMins * 60 * 1000);

    // Validate instructor availability (check overlapping non-cancelled sessions)
    await this.validateInstructorAvailability(
      course.instructorAddress,
      scheduledDate,
      endDate,
    );

    const session = await this.prisma.liveSession.create({
      data: {
        courseId: dto.courseId,
        instructorAddress: course.instructorAddress,
        title: dto.title,
        description: dto.description,
        scheduledAt: scheduledDate,
        durationMinutes: durationMins,
        capacity: dto.capacity ?? 50,
        meetingUrl: dto.meetingUrl,
        status: LiveSessionStatus.SCHEDULED,
      },
    });

    this.logger.log(
      `Live session scheduled: ${session.id} for course ${dto.courseId} at ${scheduledDate}`,
    );

    return session;
  }

  /**
   * Update or reschedule a live session.
   */
  async updateSession(user: any, sessionId: string, dto: UpdateSessionDto) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: {
        course: {
          include: { instructor: true },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Live session not found');
    }

    if (
      session.course.instructorAddress !== user.stellarAddress &&
      session.course.instructor.id !== user.id
    ) {
      throw new ForbiddenException('Only the session instructor can update session details');
    }

    let newScheduledAt = session.scheduledAt;
    let status = dto.status ?? session.status;

    if (dto.scheduledAt) {
      newScheduledAt = new Date(dto.scheduledAt);
      if (newScheduledAt.getTime() !== session.scheduledAt.getTime()) {
        status = LiveSessionStatus.RESCHEDULED;

        const duration = dto.durationMinutes ?? session.durationMinutes;
        const endDate = new Date(newScheduledAt.getTime() + duration * 60 * 1000);

        await this.validateInstructorAvailability(
          session.instructorAddress,
          newScheduledAt,
          endDate,
          sessionId,
        );
      }
    }

    return this.prisma.liveSession.update({
      where: { id: sessionId },
      data: {
        title: dto.title ?? session.title,
        description: dto.description ?? session.description,
        scheduledAt: newScheduledAt,
        durationMinutes: dto.durationMinutes ?? session.durationMinutes,
        capacity: dto.capacity ?? session.capacity,
        meetingUrl: dto.meetingUrl ?? session.meetingUrl,
        status,
      },
    });
  }

  /**
   * Cancel a live session.
   */
  async cancelSession(user: any, sessionId: string) {
    return this.updateSession(user, sessionId, {
      status: LiveSessionStatus.CANCELLED,
    });
  }

  /**
   * RSVP to a live session.
   */
  async rsvpToSession(user: any, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: {
        rsvps: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Live session not found');
    }

    // Verify enrollment
    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        studentId_courseId: {
          studentId: user.id,
          courseId: session.courseId,
        },
      },
    });

    if (!enrollment) {
      throw new ForbiddenException('Only enrolled students can RSVP to live sessions');
    }

    // Check capacity
    const rsvpCount = await this.prisma.liveSessionRsvp.count({
      where: { sessionId },
    });

    if (rsvpCount >= session.capacity) {
      throw new ConflictException('Live session is full');
    }

    return this.prisma.liveSessionRsvp.create({
      data: {
        sessionId,
        studentId: user.id,
      },
    });
  }

  /**
   * Cancel an RSVP to a live session.
   */
  async cancelRsvp(user: any, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Live session not found');
    }

    const rsvp = await this.prisma.liveSessionRsvp.findUnique({
      where: {
        sessionId_studentId: {
          sessionId,
          studentId: user.id,
        },
      },
    });

    if (!rsvp) {
      throw new NotFoundException('RSVP not found');
    }

    return this.prisma.liveSessionRsvp.delete({
      where: {
        sessionId_studentId: {
          sessionId,
          studentId: user.id,
        },
      },
    });
  }

  /**
   * List upcoming sessions for a course or instructor.
   */
  async getUpcomingSessions(courseId?: string, instructorAddress?: string) {
    const where: any = {
      status: { in: [LiveSessionStatus.SCHEDULED, LiveSessionStatus.RESCHEDULED] },
      scheduledAt: { gte: new Date() },
    };

    if (courseId) where.courseId = courseId;
    if (instructorAddress) where.instructorAddress = instructorAddress;

    return this.prisma.liveSession.findMany({
      where,
      include: { course: { select: { title: true, thumbnailUrl: true } } },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async getSessionById(sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: { course: true },
    });
    if (!session) throw new NotFoundException('Live session not found');
    return session;
  }

  /**
   * Helper to ensure no overlapping active sessions exist for an instructor.
   */
  private async validateInstructorAvailability(
    instructorAddress: string,
    start: Date,
    end: Date,
    excludeSessionId?: string,
  ) {
    const existingSessions = await this.prisma.liveSession.findMany({
      where: {
        instructorAddress,
        status: { in: [LiveSessionStatus.SCHEDULED, LiveSessionStatus.RESCHEDULED] },
        id: excludeSessionId ? { not: excludeSessionId } : undefined,
      },
    });

    for (const session of existingSessions) {
      const sessStart = session.scheduledAt;
      const sessEnd = new Date(
        sessStart.getTime() + session.durationMinutes * 60 * 1000,
      );

      // Check overlap: (start < sessEnd) && (end > sessStart)
      if (start < sessEnd && end > sessStart) {
        throw new ConflictException(
          `Instructor has an overlapping live session scheduled (${session.title})`,
        );
      }
    }
  }
}
