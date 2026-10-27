import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { GoogleAuth } from 'google-auth-library';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { QueueService } from '../../common/queue/queue.service';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';

type ChannelState = { email: boolean; push: boolean; inApp: boolean };

const DEFAULT_CHANNEL_STATE: ChannelState = { email: true, push: true, inApp: true };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queueService: QueueService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST'),
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASS'),
      },
    });
  }

  async notifyUser(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    try {
      // A missing preference row means "defaults" — nothing is inserted here, so
      // concurrent notifications for a new user cannot collide on (userId, type).
      const channelState = await this.getChannelState(userId, type);

      // The notification is always stored (audit trail); types with inApp disabled
      // are filtered out of the feed at read time.
      const notification = await this.prisma.notification.create({
        data: { userId, type, title, message, data: data ?? {} },
      });

      await this.ensureDigestPreference(userId);

      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      let emailJobId: string | undefined;
      if (user?.email && channelState.email) {
        try {
          const job = await this.queueService.enqueueNotificationEmail({
            userId,
            notificationId: notification.id,
            to: user.email,
            subject: title,
            text: message,
            type,
          });
          emailJobId = job.id;
        } catch (error) {
          this.logger.error(`Failed to enqueue email for user ${userId}`, error.message);
        }
      }

      if (channelState.push) {
        await this.sendPushNotification(userId, type, title, message, data);
      }

      return { ...notification, emailJobId };
    } catch (error) {
      this.logger.error(`Failed to notify user ${userId}`, error.message);
    }
  }

  async findForUser(userId: string, unreadOnly = false, page = 1, limit = 20) {
    const where: any = { userId };
    if (unreadOnly) where.read = false;

    const hiddenTypes = await this.getInAppDisabledTypes(userId);
    if (hiddenTypes.length) where.type = { notIn: hiddenTypes };

    const [notifications, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data: notifications, meta: { total, page, limit } };
  }

  async getUnreadCount(userId: string) {
    const hiddenTypes = await this.getInAppDisabledTypes(userId);
    const count = await this.prisma.notification.count({
      where: {
        userId,
        read: false,
        ...(hiddenTypes.length ? { type: { notIn: hiddenTypes } } : {}),
      },
    });
    return { count, unreadCount: count };
  }

  async processEmailJob(data: {
    notificationId: string;
    to: string;
    subject: string;
    text: string;
    type: NotificationType;
  }) {
    await this.sendEmail(data.to, data.subject, data.text, data.type);
    await this.prisma.notification.update({
      where: { id: data.notificationId },
      data: { emailSent: true },
    });
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException('You do not have access to this notification');
    }

    let updatedNotification = notification;
    if (!notification.read) {
      updatedNotification = await this.prisma.notification.update({
        where: { id },
        data: { read: true },
      });
    }

    const unreadCount = await this.prisma.notification.count({
      where: { userId, read: false },
    });

    return {
      success: true,
      notification: updatedNotification,
      count: unreadCount,
      unreadCount,
    };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });

    const unreadCount = await this.prisma.notification.count({
      where: { userId, read: false },
    });

    return {
      success: true,
      markedCount: result.count,
      count: unreadCount,
      unreadCount,
    };
  }

  async registerDeviceToken(userId: string, token: string, platform = 'mobile') {
    this.assertValidToken(token);

    const normalized = token.trim();
    const existing = await this.prisma.notificationDeviceToken.findUnique({
      where: { token: normalized },
    });

    if (existing && existing.userId !== userId) {
      await this.prisma.notificationDeviceToken.update({
        where: { id: existing.id },
        data: { userId, isActive: true, platform },
      });
      return { registered: true, token: normalized, userId };
    }

    await this.prisma.notificationDeviceToken.upsert({
      where: { token: normalized },
      update: { userId, isActive: true, platform },
      create: { userId, token: normalized, platform, isActive: true },
    });

    return { registered: true, token: normalized, userId };
  }

  async listActiveTokens(userId: string) {
    const tokens = await this.prisma.notificationDeviceToken.findMany({
      where: { userId, isActive: true },
      select: { token: true, platform: true },
    });

    return tokens;
  }

  /**
   * Returns the channel settings for every notification type. Types without a
   * stored row fall back to the defaults (all channels enabled) without writing.
   */
  async getPreferences(userId: string) {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId },
    });
    const stored = new Map(prefs.map((pref) => [pref.type, pref]));

    return Object.values(NotificationType)
      .sort()
      .reduce((acc, type) => {
        const pref = stored.get(type);
        acc[type] = pref
          ? { email: pref.email, push: pref.push, inApp: pref.inApp }
          : { ...DEFAULT_CHANNEL_STATE };
        return acc;
      }, {} as Record<string, ChannelState>);
  }

  async updatePreference(userId: string, type: NotificationType, preferences: UpdateNotificationPreferenceDto) {
    this.assertValidNotificationType(type);

    // True PATCH semantics: only the channels present in the body are changed.
    const changes: Partial<ChannelState> = {};
    if (preferences.email !== undefined) changes.email = preferences.email;
    if (preferences.push !== undefined) changes.push = preferences.push;
    if (preferences.inApp !== undefined) changes.inApp = preferences.inApp;

    const record = await this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      update: changes,
      create: {
        userId,
        type,
        ...DEFAULT_CHANNEL_STATE,
        ...changes,
      },
    });

    return record;
  }

  async getCurrentPreferenceSettings(userId: string) {
    return this.getPreferences(userId);
  }

  async updateDigestPreference(userId: string, emailEnabled: boolean) {
    return this.prisma.notificationDigestPreference.upsert({
      where: { userId },
      update: { emailEnabled },
      create: { userId, emailEnabled },
    });
  }

  @Cron('0 0 8 * * *')
  async sendDailyDigest() {
    const users = await this.prisma.notificationDigestPreference.findMany({
      where: { emailEnabled: true },
      include: { user: true },
    });

    for (const entry of users) {
      const since = entry.lastDigestAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
      const unreadNotifications = await this.prisma.notification.findMany({
        where: {
          userId: entry.userId,
          read: false,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!unreadNotifications.length) {
        continue;
      }

      const html = this.renderDigestTemplate(entry.user.name ?? entry.user.email ?? 'there', unreadNotifications);
      const recipient = entry.user.email;
      if (!recipient) {
        this.logger.warn(`Skipping digest for ${entry.userId}: no email address`);
        continue;
      }

      try {
        await this.transporter.sendMail({
          from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
          to: recipient,
          subject: 'Your daily Hamplard digest',
          text: `You have ${unreadNotifications.length} unread updates.`,
          html,
        });
        await this.prisma.notificationDigestPreference.update({
          where: { id: entry.id },
          data: { lastDigestAt: new Date() },
        });
        this.logger.log(`Digest email sent to ${recipient}`);
      } catch (error) {
        this.logger.error(`Digest email failed for ${recipient}`, error.message);
      }
    }
  }

  /** Emails a generated invoice PDF to the student. */
  async sendInvoiceEmail(
    to: string,
    invoiceNumber: number,
    courseTitle: string,
    pdfBuffer: Buffer,
  ): Promise<boolean> {
    const platformName = this.config.get('PLATFORM_NAME', 'Hamplard');
    const safePlatformName = this.escapeHtml(platformName);
    const safeCourseTitle = this.escapeHtml(courseTitle);
    try {
      await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
        to,
        subject: `🧾 ${platformName} — Invoice #${invoiceNumber}`,
        text: `Thank you for your purchase of "${courseTitle}". Your invoice #${invoiceNumber} is attached.`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#059669;">${safePlatformName}</h2>
            <p style="color:#444;line-height:1.6;">
              Thank you for your purchase of "${safeCourseTitle}". Your invoice #${invoiceNumber} is attached.
            </p>
          </div>
        `,
        attachments: [
          {
            filename: `invoice-${invoiceNumber}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });
      return true;
    } catch (error) {
      this.logger.error(`Invoice email failed to ${to}`, error.message);
      return false;
    }
  }

  private async sendPushNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, any>,
  ) {
    const payload = this.buildPushPayload(type, title, message, data);
    const tokens = await this.listActiveTokens(userId);

    if (!tokens.length) {
      this.logger.debug(`No active push tokens for user ${userId}`);
      return;
    }

    let accessToken: string;
    let projectId: string;
    try {
      ({ accessToken, projectId } = await this.getFcmAccessToken());
    } catch (error) {
      this.logger.warn(`Push delivery skipped for ${userId}: ${(error as Error).message}`);
      return;
    }

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    for (const tokenEntry of tokens) {
      try {
        const response = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: tokenEntry.token,
              notification: payload.notification,
              data: payload.data,
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          if (this.isInvalidFcmTokenResponse(response.status, errorBody)) {
            await this.deactivateToken(tokenEntry.token);
            this.logger.warn(`Deactivated invalid FCM token for ${userId} via ${tokenEntry.platform ?? 'mobile'}`);
          } else {
            throw new Error(`FCM returned ${response.status}: ${errorBody.slice(0, 200)}`);
          }
          continue;
        }

        this.logger.log(`Push delivered for ${userId} via ${tokenEntry.platform ?? 'mobile'}`);
      } catch (error) {
        this.logger.error(`Push delivery failed for ${userId}`, (error as Error).message);
      }
    }
  }

  private async getFcmAccessToken(): Promise<{ accessToken: string; projectId: string }> {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are not configured',
      );
    }

    const auth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const accessToken = typeof token === 'string' ? token : token?.token;
    if (!accessToken) {
      throw new Error('Failed to obtain FCM access token');
    }
    return { accessToken, projectId };
  }

  private isInvalidFcmTokenResponse(status: number, body: string): boolean {
    if (status === 404 || status === 400) {
      return /UNREGISTERED|INVALID_ARGUMENT|Requested entity was not found|not a valid FCM/i.test(body);
    }
    return false;
  }

  private async deactivateToken(token: string) {
    await this.prisma.notificationDeviceToken.updateMany({
      where: { token },
      data: { isActive: false },
    });
  }

  private buildPushPayload(type: NotificationType, title: string, message: string, data?: Record<string, any>) {
    const baseData: Record<string, string> = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      baseData[key] = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    }

    return {
      notification: {
        title,
        body: message,
      },
      data: {
        type,
        ...baseData,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
    };
  }

  private assertValidToken(token: string) {
    if (!token || !/^[A-Za-z0-9:_-]{10,}$/.test(token.trim())) {
      throw new BadRequestException('Device token must be a non-empty Firebase-like token');
    }
  }

  private assertValidNotificationType(type: NotificationType) {
    if (!Object.values(NotificationType).includes(type as NotificationType)) {
      throw new BadRequestException('Invalid notification type identifier');
    }
  }

  /** Single-query lookup of one type's channels; a missing row means defaults. */
  private async getChannelState(userId: string, type: NotificationType): Promise<ChannelState> {
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
    });
    return pref
      ? { email: pref.email, push: pref.push, inApp: pref.inApp }
      : { ...DEFAULT_CHANNEL_STATE };
  }

  private async getInAppDisabledTypes(userId: string): Promise<NotificationType[]> {
    const disabled = await this.prisma.notificationPreference.findMany({
      where: { userId, inApp: false },
      select: { type: true },
    });
    return disabled.map((pref) => pref.type);
  }

  /**
   * Opts the user into the daily digest by default. `skipDuplicates` turns the
   * insert into ON CONFLICT DO NOTHING, so concurrent calls never throw.
   */
  private async ensureDigestPreference(userId: string) {
    await this.prisma.notificationDigestPreference.createMany({
      data: [{ userId, emailEnabled: true }],
      skipDuplicates: true,
    });
  }

  private renderDigestTemplate(userName: string, notifications: Array<{ title: string; message: string }>) {
    const safeUserName = this.escapeHtml(userName);
    const items = notifications
      .map((item) => `<li style="margin-bottom:8px;"><strong>${this.escapeHtml(item.title)}</strong><div>${this.escapeHtml(item.message)}</div></li>`)
      .join('');

    return `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#059669;">Hi ${safeUserName}</h2>
        <p>You have ${notifications.length} unread updates waiting for you.</p>
        <ul>${items}</ul>
      </div>
    `;
  }

  private escapeHtml(value: string) {
    return (value ?? '').replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[character];
    });
  }

  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    type: NotificationType,
  ) {
    const platformName = this.config.get('PLATFORM_NAME', 'Hamplard');
    const emoji: Partial<Record<NotificationType, string>> = {
      COURSE_APPROVED: '✅',
      COURSE_REJECTED: '📝',
      ENROLLMENT_CONFIRMED: '🎓',
      COURSE_COMPLETED: '🏆',
      CERTIFICATE_ISSUED: '🎓',
      CERTIFICATE_REVOKED: '❌',
      ASSIGNMENT_APPROVED: '✅',
      ASSIGNMENT_REJECTED: '🔄',
      ASSIGNMENT_SUBMITTED: '📋',
      PAYMENT_RECEIVED: '💰',
      NEW_ENROLLMENT: '👋',
      DISPUTE_FILED: '⚠️',
      DISPUTE_RESOLVED: '✅',
      KYC_APPROVED: '🪪',
      KYC_REJECTED: '❌',
      PAYOUT_PROCESSED: '💸',
      PAYOUT_SCHEDULED: '📅',
      NEW_DEVICE_LOGIN: '🔐',
    };

    await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
        to,
        subject: `${emoji[type] ?? '📬'} ${platformName} — ${subject}`,
        text,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#059669;">${this.escapeHtml(platformName)}</h2>
            <p style="color:#444;line-height:1.6;">${this.escapeHtml(text)}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
            <small style="color:#999;">
              You're receiving this because you have an account on ${this.escapeHtml(platformName)}.
            </small>
          </div>
        `,
    });
  }
}
