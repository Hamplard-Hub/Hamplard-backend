import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
      const notification = await this.prisma.notification.create({
        data: { userId, type, title, message, data: data ?? {} },
      });

      const preferences = await this.getPreferences(userId);
      const channelState = preferences[type] ?? { email: true, push: true, inApp: true };

      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.email && channelState.email) {
        await this.sendEmail(user.email, title, message, type);
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { emailSent: true },
        });
      }

      if (channelState.push) {
        await this.sendPushNotification(userId, type, title, message, data);
      }

      return notification;
    } catch (error) {
      this.logger.error(`Failed to notify user ${userId}`, error.message);
    }
  }

  async findForUser(userId: string, unreadOnly = false, page = 1, limit = 20) {
    const where: any = { userId };
    if (unreadOnly) where.read = false;

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

  async markRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
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

  async getPreferences(userId: string) {
    await this.ensurePreferenceDefaults(userId);

    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId },
      orderBy: { type: 'asc' },
    });

    return prefs.reduce((acc, pref) => {
      acc[pref.type] = { email: pref.email, push: pref.push, inApp: pref.inApp };
      return acc;
    }, {} as Record<string, { email: boolean; push: boolean; inApp: boolean }>);
  }

  async updatePreference(userId: string, type: NotificationType, preferences: { email?: boolean; push?: boolean; inApp?: boolean }) {
    this.assertValidNotificationType(type);

    await this.ensurePreferenceDefaults(userId);

    const record = await this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      update: {
        email: preferences.email ?? true,
        push: preferences.push ?? true,
        inApp: preferences.inApp ?? true,
      },
      create: {
        userId,
        type,
        email: preferences.email ?? true,
        push: preferences.push ?? true,
        inApp: preferences.inApp ?? true,
      },
    });

    return record;
  }

  async getCurrentPreferenceSettings(userId: string) {
    return this.getPreferences(userId);
  }

  async updateDigestPreference(userId: string, emailEnabled: boolean) {
    await this.ensurePreferenceDefaults(userId);

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
    try {
      await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
        to,
        subject: `🧾 ${platformName} — Invoice #${invoiceNumber}`,
        text: `Thank you for your purchase of "${courseTitle}". Your invoice #${invoiceNumber} is attached.`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#059669;">${platformName}</h2>
            <p style="color:#444;line-height:1.6;">
              Thank you for your purchase of "${courseTitle}". Your invoice #${invoiceNumber} is attached.
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

    const serverKey = this.config.get<string>('FIREBASE_SERVER_KEY');
    if (!serverKey) {
      this.logger.warn(`Push delivery skipped for ${userId}: FIREBASE_SERVER_KEY is not configured`);
      return;
    }

    const fcmUrl = this.config.get<string>('FIREBASE_FCM_URL', 'https://fcm.googleapis.com/fcm/send');

    for (const tokenEntry of tokens) {
      try {
        const response = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            Authorization: `key=${serverKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: tokenEntry.token,
            notification: payload.notification,
            data: payload.data,
          }),
        });

        if (!response.ok) {
          throw new Error(`FCM returned ${response.status}`);
        }

        this.logger.log(`Push delivered for ${userId} via ${tokenEntry.platform ?? 'mobile'}`);
      } catch (error) {
        this.logger.error(`Push delivery failed for ${userId}`, error.message);
      }
    }
  }

  private buildPushPayload(type: NotificationType, title: string, message: string, data?: Record<string, any>) {
    const baseData = {
      type,
      ...(data ?? {}),
    };

    return {
      notification: {
        title,
        body: message,
      },
      data: {
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

  private async ensurePreferenceDefaults(userId: string) {
    const availableTypes = Object.values(NotificationType);
    const existing = await this.prisma.notificationPreference.findMany({
      where: { userId },
      select: { type: true },
    });
    const existingTypes = new Set(existing.map((item) => item.type));

    for (const type of availableTypes) {
      if (!existingTypes.has(type as NotificationType)) {
        await this.prisma.notificationPreference.create({
          data: {
            userId,
            type: type as NotificationType,
            email: true,
            push: true,
            inApp: true,
          },
        });
      }
    }

    const digestPreference = await this.prisma.notificationDigestPreference.findUnique({
      where: { userId },
    });
    if (!digestPreference) {
      await this.prisma.notificationDigestPreference.create({
        data: { userId, emailEnabled: true },
      });
    }
  }

  private renderDigestTemplate(userName: string, notifications: Array<{ title: string; message: string }>) {
    const items = notifications
      .map((item) => `<li style="margin-bottom:8px;"><strong>${item.title}</strong><div>${item.message}</div></li>`)
      .join('');

    return `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#059669;">Hi ${userName}</h2>
        <p>You have ${notifications.length} unread updates waiting for you.</p>
        <ul>${items}</ul>
      </div>
    `;
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
    };

    try {
      await this.transporter.sendMail({
        from: this.config.get('EMAIL_FROM', 'noreply@hamplard.com'),
        to,
        subject: `${emoji[type] ?? '📬'} ${platformName} — ${subject}`,
        text,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#059669;">${platformName}</h2>
            <p style="color:#444;line-height:1.6;">${text}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
            <small style="color:#999;">
              You're receiving this because you have an account on ${platformName}.
            </small>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Email failed to ${to}`, error.message);
    }
  }
}
