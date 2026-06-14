import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
      host:   this.config.get('SMTP_HOST'),
      port:   this.config.get<number>('SMTP_PORT', 587),
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

      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.email) {
        await this.sendEmail(user.email, title, message, type);
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { emailSent: true },
        });
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

  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    type: NotificationType,
  ) {
    const platformName = this.config.get('PLATFORM_NAME', 'Hamplard');
    const emoji: Partial<Record<NotificationType, string>> = {
      COURSE_APPROVED:       '✅',
      COURSE_REJECTED:       '📝',
      ENROLLMENT_CONFIRMED:  '🎓',
      COURSE_COMPLETED:      '🏆',
      CERTIFICATE_ISSUED:    '🎓',
      ASSIGNMENT_APPROVED:   '✅',
      ASSIGNMENT_REJECTED:   '🔄',
      ASSIGNMENT_SUBMITTED:  '📋',
      PAYMENT_RECEIVED:      '💰',
      NEW_ENROLLMENT:        '👋',
    };

    try {
      await this.transporter.sendMail({
        from:    this.config.get('EMAIL_FROM', `noreply@hamplard.com`),
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
