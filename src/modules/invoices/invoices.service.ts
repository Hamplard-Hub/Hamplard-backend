// invoices.service.ts
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import PDFDocument = require('pdfkit');
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface InvoiceRequester {
  id: string;
  role: UserRole;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Generates an invoice for a confirmed enrollment payment, renders it as a
   * PDF, and emails it to the student. Called once an enrollment's on-chain
   * transaction has been confirmed.
   */
  async generateForEnrollment(enrollmentId: string) {
    const existing = await this.prisma.invoice.findUnique({ where: { enrollmentId } });
    if (existing) return existing;

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { course: true, student: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');

    await this.validatePayment(enrollment.txHash, Number(enrollment.amountPaid));

    const invoice = await this.prisma.invoice.create({
      data: {
        enrollmentId: enrollment.id,
        studentId: enrollment.studentId,
        courseId: enrollment.courseId,
        amount: enrollment.amountPaid,
        txHash: enrollment.txHash,
      },
    });

    const pdfBuffer = await this.renderInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      studentName: enrollment.student.name ?? enrollment.student.stellarAddress,
      courseTitle: enrollment.course.title,
      amount: Number(enrollment.amountPaid),
      txHash: enrollment.txHash,
      issuedAt: invoice.issuedAt,
    });

    if (enrollment.student.email) {
      const sent = await this.notifications.sendInvoiceEmail(
        enrollment.student.email,
        invoice.invoiceNumber,
        enrollment.course.title,
        pdfBuffer,
      );
      if (sent) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { emailSent: true },
        });
      }
    }

    this.logger.log(`Invoice #${invoice.invoiceNumber} generated for enrollment ${enrollmentId}`);
    return invoice;
  }

  /**
   * Paginated list of the authenticated student's own invoices, newest first.
   * Always scoped by the caller's id — never by a client-supplied value.
   */
  async findMine(studentId: string, page = 1, limit = 20) {
    const where = { studentId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        select: {
          id: true,
          invoiceNumber: true,
          enrollmentId: true,
          courseId: true,
          amount: true,
          txHash: true,
          emailSent: true,
          issuedAt: true,
          course: { select: { id: true, title: true } },
        },
        orderBy: { issuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Renders an invoice PDF on demand for its owner or an admin.
   * A non-owner gets a 404 (not 403) so invoice ids can't be probed for existence.
   */
  async getPdfForDownload(
    invoiceId: string,
    user: InvoiceRequester,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { course: true, student: true },
    });

    const isAdmin = user.role === UserRole.ADMIN;
    if (!invoice || (!isAdmin && invoice.studentId !== user.id)) {
      throw new NotFoundException('Invoice not found');
    }

    const buffer = await this.renderInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      studentName: invoice.student.name ?? invoice.student.stellarAddress ?? invoice.student.email,
      courseTitle: invoice.course.title,
      amount: Number(invoice.amount),
      txHash: invoice.txHash,
      issuedAt: invoice.issuedAt,
    });

    return { buffer, filename: `invoice-${invoice.invoiceNumber}.pdf` };
  }

  /**
   * Confirms the on-chain transaction backing the payment actually succeeded
   * before an invoice is issued for it.
   * Issue #249: Rejects invoices for unverified payment transactions.
   */
  private async validatePayment(txHash: string | null, amountPaid: number) {
    if (amountPaid <= 0) {
      throw new BadRequestException('Cannot invoice a payment with a non-positive amount');
    }
    if (!txHash) return;

    const txStatus = await this.stellar.getTransactionStatus(txHash);
    if (txStatus === null) {
      throw new BadRequestException('Cannot invoice a payment whose transaction hash could not be verified (not found on-chain)');
    }
    if (!txStatus.successful) {
      throw new BadRequestException('Cannot invoice a payment whose on-chain transaction did not succeed');
    }
  }

  private renderInvoicePdf(data: {
    invoiceNumber: number;
    studentName: string;
    courseTitle: string;
    amount: number;
    txHash: string | null;
    issuedAt: Date;
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text('Hamplard', { continued: false });
      doc.fontSize(10).fillColor('#666').text('Africa\'s practical skills learning platform');
      doc.moveDown(2);

      doc.fillColor('#000').fontSize(16).text(`Invoice #${data.invoiceNumber}`);
      doc.fontSize(10).fillColor('#666').text(`Issued: ${data.issuedAt.toDateString()}`);
      doc.moveDown(1.5);

      doc.fillColor('#000').fontSize(12).text(`Billed to: ${data.studentName}`);
      doc.moveDown(1);

      doc.fontSize(12).text(`Course: ${data.courseTitle}`);
      doc.text(`Amount paid: ${data.amount.toFixed(2)} USDC`);
      if (data.txHash) doc.text(`Transaction hash: ${data.txHash}`);
      doc.moveDown(2);

      doc.fontSize(9).fillColor('#999').text('Thank you for learning with Hamplard.');
      doc.end();
    });
  }
}
