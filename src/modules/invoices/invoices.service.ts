// invoices.service.ts
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PDFDocument = require('pdfkit');
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface InvoiceRequester {
  id: string;
  role: UserRole;
}

/** Price snapshot fields stored on the enrollment at checkout (issue #333). */
type Amount = Prisma.Decimal | number | string | null | undefined;
export interface EnrollmentPriceSnapshot {
  listPrice?: Amount;
  couponDiscount?: Amount;
  referralDiscount?: Amount;
  taxRegion?: string | null;
  taxRatePercent?: Amount;
  taxAmount?: Amount;
}

/** Itemised invoice amounts (issue #334). subtotal - discountTotal + taxAmount === total. */
export interface InvoiceBreakdown {
  currency: string;
  subtotal: number;
  couponDiscount: number;
  referralDiscount: number;
  discountTotal: number;
  netAmount: number;
  taxRegion: string | null;
  taxRatePercent: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly config?: ConfigService,
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
      breakdown: this.buildBreakdown(Number(enrollment.amountPaid), enrollment),
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
      include: { course: true, student: true, enrollment: true },
    });

    const isAdmin = user.role === UserRole.ADMIN;
    if (!invoice || (!isAdmin && invoice.studentId !== user.id)) {
      throw new NotFoundException('Invoice not found');
    }

    const buffer = await this.renderInvoicePdf({
      invoiceNumber: invoice.invoiceNumber,
      studentName: invoice.student.name ?? invoice.student.stellarAddress ?? invoice.student.email,
      courseTitle: invoice.course.title,
      breakdown: this.buildBreakdown(Number(invoice.amount), invoice.enrollment),
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

  /**
   * Itemises an invoice from the enrollment price snapshot (issue #334).
   * Enrollments created before checkout quotes have no snapshot, so the
   * amount paid is shown as a single untaxed line.
   */
  buildBreakdown(amountPaid: number, snapshot?: EnrollmentPriceSnapshot | null): InvoiceBreakdown {
    const round = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
    const paid = round(amountPaid);

    if (!snapshot || snapshot.listPrice === null || snapshot.listPrice === undefined) {
      return {
        currency: 'USDC',
        subtotal: paid,
        couponDiscount: 0,
        referralDiscount: 0,
        discountTotal: 0,
        netAmount: paid,
        taxRegion: null,
        taxRatePercent: 0,
        taxAmount: 0,
        total: paid,
        amountPaid: paid,
      };
    }

    const subtotal = round(Number(snapshot.listPrice));
    const couponDiscount = round(Number(snapshot.couponDiscount ?? 0));
    const referralDiscount = round(Number(snapshot.referralDiscount ?? 0));
    const discountTotal = round(couponDiscount + referralDiscount);
    const netAmount = round(Math.max(0, subtotal - discountTotal));
    const taxAmount = round(Number(snapshot.taxAmount ?? 0));

    return {
      currency: 'USDC',
      subtotal,
      couponDiscount,
      referralDiscount,
      discountTotal,
      netAmount,
      taxRegion: snapshot.taxRegion ?? null,
      taxRatePercent: Number(snapshot.taxRatePercent ?? 0),
      taxAmount,
      total: round(netAmount + taxAmount),
      amountPaid: paid,
    };
  }

  /** Seller details printed on every invoice, from config (issue #334). */
  private getPlatformDetails() {
    return {
      name: this.config?.get<string>('PLATFORM_NAME') || 'Hamplard',
      address: this.config?.get<string>('PLATFORM_ADDRESS') || null,
      taxId: this.config?.get<string>('PLATFORM_TAX_ID') || null,
    };
  }

  private renderInvoicePdf(data: {
    invoiceNumber: number;
    studentName: string;
    courseTitle: string;
    breakdown: InvoiceBreakdown;
    txHash: string | null;
    issuedAt: Date;
  }): Promise<Buffer> {
    const platform = this.getPlatformDetails();
    const { breakdown: b } = data;
    const money = (v: number) => `${v.toFixed(2)} ${b.currency}`;

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(20).text(platform.name, { continued: false });
      doc.fontSize(10).fillColor('#666').text('Africa\'s practical skills learning platform');
      if (platform.address) doc.text(platform.address);
      if (platform.taxId) doc.text(`Tax ID: ${platform.taxId}`);
      doc.moveDown(2);

      doc.fillColor('#000').fontSize(16).text(`Invoice #${data.invoiceNumber}`);
      doc.fontSize(10).fillColor('#666').text(`Issued: ${data.issuedAt.toDateString()}`);
      doc.moveDown(1.5);

      doc.fillColor('#000').fontSize(12).text(`Billed to: ${data.studentName}`);
      doc.moveDown(1);

      doc.fontSize(12).text(`Course: ${data.courseTitle}`);
      doc.moveDown(0.5);

      const line = (label: string, value: string) => {
        const y = doc.y;
        doc.text(label, 50, y, { width: 300 });
        doc.text(value, 350, y, { width: 200, align: 'right' });
      };

      doc.fontSize(11);
      line('Subtotal', money(b.subtotal));
      if (b.couponDiscount > 0) line('Coupon discount', `-${money(b.couponDiscount)}`);
      if (b.referralDiscount > 0) line('Referral discount', `-${money(b.referralDiscount)}`);
      if (b.discountTotal > 0) line('Net amount', money(b.netAmount));
      const taxLabel = b.taxRegion
        ? `Tax (${b.taxRegion}, ${b.taxRatePercent}%)`
        : 'Tax';
      line(taxLabel, money(b.taxAmount));
      doc.moveDown(0.25);
      doc.fontSize(12);
      line('Total', money(b.total));
      if (Math.abs(b.amountPaid - b.total) >= 0.005) {
        doc.fontSize(10);
        line('Amount paid on-chain', money(b.amountPaid));
      }

      doc.x = 50;
      doc.moveDown(1);
      doc.fontSize(10);
      if (data.txHash) doc.text(`Transaction hash: ${data.txHash}`);
      doc.moveDown(2);

      doc.fontSize(9).fillColor('#999').text(`Thank you for learning with ${platform.name}.`);
      doc.end();
    });
  }
}
