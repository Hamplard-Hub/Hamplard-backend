import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CronMonitorService } from '../cron-monitor/cron-monitor.service';
import { LiveSessionStatus, NotificationType } from '@prisma/client';

@Injectable()
export class LiveSessionRemindersService {
  private readonly logger = new Logger(LiveSessionRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly cronMonitor?: CronMonitorService,
  ) {}

  /**
   * Scheduled cron job running every 5 minutes to check for upcoming live sessions
   * starting within the next 60 minutes and send reminder notifications to enrolled students.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleUpcomingSessionReminders() {
    const doRemind = async () => {
      this.logger.log('Checking for upcoming live session reminders...');

      const now = new Date();
      const reminderWindowEnd = new Date(now.getTime() + 60 * 60 * 1000); // 60 minutes from now

      // Find non-cancelled sessions starting within the next 60 minutes where reminder has not been sent
      const upcomingSessions = await this.prisma.liveSession.findMany({
        where: {
          status: { in: [LiveSessionStatus.SCHEDULED, LiveSessionStatus.RESCHEDULED] },
          reminderSent: false,
          scheduledAt: {
            gte: now,
            lte: reminderWindowEnd,
          },
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { status: 'ACTIVE' },
                include: { student: true },
              },
            },
          },
        },
      });

      if (upcomingSessions.length === 0) {
        this.logger.log('No upcoming live session reminders to send.');
        return { sessionsProcessed: 0, notificationsSent: 0 };
      }

      let totalNotificationsSent = 0;

      for (const session of upcomingSessions) {
        // Re-validate session has not been cancelled
        if (session.status === LiveSessionStatus.CANCELLED) {
          continue;
        }

        const enrolledStudents = session.course.enrollments.map((e) => e.student);
        let sessionDeliveryCount = 0;

        for (const student of enrolledStudents) {
          try {
            await this.notifications.notifyUser(
              student.id,
              NotificationType.LIVE_SESSION_REMINDER,
              '⏰ Upcoming Live Session Reminder',
              `Reminder: The live session "${session.title}" for course "${session.course.title}" starts soon at ${session.scheduledAt.toISOString()}.`,
              {
                sessionId: session.id,
                courseId: session.courseId,
                scheduledAt: session.scheduledAt,
                meetingUrl: session.meetingUrl,
              },
            );
            sessionDeliveryCount++;
            totalNotificationsSent++;
          } catch (err: any) {
            this.logger.error(
              `Failed to send session reminder to student ${student.id} for session ${session.id}`,
              err?.stack,
            );
          }
        }

        // Mark reminderSent state on the session
        await this.prisma.liveSession.update({
          where: { id: session.id },
          data: { reminderSent: true },
        });

        this.logger.log(
          `Delivery Confirmation Log: Live Session ${session.id} ("${session.title}") reminders sent to ${sessionDeliveryCount} enrolled student(s).`,
        );
      }

      return {
        sessionsProcessed: upcomingSessions.length,
        notificationsSent: totalNotificationsSent,
      };
    };

    if (this.cronMonitor) {
      return this.cronMonitor.run('live-session-reminders', doRemind);
    }
    return doRemind();
  }
}
