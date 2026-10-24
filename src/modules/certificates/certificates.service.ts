import {
  Injectable, NotFoundException, ForbiddenException, Logger,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExamsService } from '../exams/exams.service';
import { NotificationType, Prisma, UserRole } from '@prisma/client';
import { UploadsService } from '../uploads/uploads.service';

/**
 * Issue #246 — projection for the unauthenticated certificate endpoints.
 * Revocation is exposed only as status flags; the revoking admin's identity
 * (`revokedBy` / `revokedById`), internal user ids and the stored PDF path
 * are never selected.
 */
export const PUBLIC_CERTIFICATE_SELECT = {
  id: true,
  courseId: true,
  courseTitle: true,
  instructorAddress: true,
  txHash: true,
  isRevoked: true,
  revokedAt: true,
  issuedAt: true,
  student: { select: { name: true, stellarAddress: true } },
  course: {
    select: {
      id: true,
      title: true,
      category: true,
      level: true,
      thumbnailUrl: true,
      instructor: { select: { name: true, stellarAddress: true } },
    },
  },
} satisfies Prisma.CertificateSelect;

export type PublicCertificate = Prisma.CertificateGetPayload<{
  select: typeof PUBLIC_CERTIFICATE_SELECT;
}>;

/** Authenticated caller requesting a certificate download. */
export interface CertificateRequester {
  id: string;
  stellarAddress?: string | null;
  role: UserRole;
}
import { CertificateRenderData } from './certificate-template.types';
import { v4 as uuidv4 } from 'uuid';
import { CertificatePdfService } from '../certificates/certificate-pdf.service';

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly examsService: ExamsService,
    private readonly pdfService: CertificatePdfService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * Issue a certificate for a student who has completed a course.
   *
   * Flow:
   *  1. Verify the student's enrollment is COMPLETED (100% progress)
   *  2. Verify student passed the required certification exam (if one exists)
   *  3. Verify no certificate already exists
   *  4. Store the certificate record in the DB
   *  5. Generate and store the PDF certificate
   *  6. The frontend/admin wallet then calls issue_certificate() on-chain
   *     and sends back the txHash to update the DB record
   *  7. Notify the student
   */
  async issue(adminId: string, studentId: string, courseId: string): Promise<any> {
    // Verify enrollment exists and is completed
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: { course: true, student: true },
    });

    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== 'COMPLETED') {
      throw new ForbiddenException('Student has not completed this course yet');
    }

    // Verify certification exam has been passed (if exam exists)
    const passedExam = await this.examsService.hasPassedExam(studentId, courseId);
    if (!passedExam) {
      throw new ForbiddenException('Student has not passed the required certification exam for this course');
    }

    // Check for existing certificate
    const existing = await this.prisma.certificate.findFirst({
      where: { studentId, courseId },
    });
    if (existing) throw new ForbiddenException('Certificate already issued for this enrollment');

    // Generate a unique certificate ID
    const certificateId = `CERT-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

    // Create DB record
    // Issue #248: Catch P2002 (unique constraint violation) for concurrent issuance
    let certificate;
    try {
      certificate = await this.prisma.certificate.create({
        data: {
          id:                certificateId,
          studentId,
          courseId,
          courseTitle:       enrollment.course.title,
          instructorAddress: enrollment.course.instructorAddress,
        },
        include: { student: true, course: true },
      });
    } catch (error) {
      if (error.code === 'P2002' && error.meta?.target?.includes('studentId_courseId')) {
        throw new ConflictException('Certificate already issued for this enrollment');
      }
      throw error;
    }

    // Generate PDF certificate using the course's category for template lookup
    const renderData: CertificateRenderData = {
      studentName:       enrollment.student.name,
      courseTitle:       enrollment.course.title,
      certificateId,
      issuedAt:          certificate.issuedAt,
      category:          enrollment.course.category,
    };

    const pdfBuffer = await this.pdfService.renderForCategory(
      enrollment.course.category,
      renderData,
    );

    // Issue #245 — persist the PDF so it can actually be downloaded later.
    const stored = await this.uploads.saveBuffer(pdfBuffer, 'certificates', `${certificateId}.pdf`);
    const pdfUrl = stored.originUrl;
    const updatedCert = await this.prisma.certificate.update({
      where: { id: certificateId },
      data: { pdfUrl },
    });

    this.logger.log(`Certificate issued: ${certificateId} for student ${studentId}, PDF: ${pdfUrl}`);

    await this.notifications.notifyUser(
      studentId,
      NotificationType.CERTIFICATE_ISSUED,
      '🎓 Certificate Issued!',
      `Congratulations! Your certificate for "${enrollment.course.title}" has been issued.`,
      { certificateId, courseId },
    );

    return updatedCert;
  }

  /** Update the txHash after the admin calls issue_certificate() on-chain */
  async updateTxHash(certificateId: string, txHash: string) {
    return this.prisma.certificate.update({
      where: { id: certificateId },
      data: { txHash },
    });
  }

  async findByStudent(studentId: string) {
    return this.prisma.certificate.findMany({
      where: { studentId },
      include: { course: { include: { instructor: { select: { name: true } } } } },
      orderBy: { issuedAt: 'desc' },
    });
  }

  /**
   * Full certificate record including the revoking admin. Internal use and
   * admin-only routes — public endpoints must use `findPublicById` (#246).
   */
  async findById(certificateId: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: {
        student: { select: { id: true, name: true, stellarAddress: true } },
        course:  { include: { instructor: { select: { name: true, stellarAddress: true } } } },
        revokedBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return cert;
  }

  /** Issue #246 — public certificate lookup without admin PII. */
  async findPublicById(certificateId: string): Promise<PublicCertificate> {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      select: PUBLIC_CERTIFICATE_SELECT,
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return cert;
  }

  /**
   * Issue #245 — returns the PDF bytes for the certificate holder or an ADMIN.
   * Certificates issued before PDFs were persisted have no file on disk; they
   * are re-rendered and stored on first download.
   */
  async getPdfForDownload(
    certificateId: string,
    user: CertificateRequester,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const cert = await this.findById(certificateId);

    const isAdmin = user.role === UserRole.ADMIN;
    const isHolder =
      cert.studentId === user.id ||
      (!!user.stellarAddress && cert.student?.stellarAddress === user.stellarAddress);
    if (!isAdmin && !isHolder) {
      throw new ForbiddenException('Only the certificate holder or an admin can download this certificate');
    }

    let buffer = cert.pdfUrl ? this.uploads.readStoredFile(cert.pdfUrl) : null;

    if (!buffer) {
      buffer = await this.pdfService.renderForCategory(cert.course.category, {
        studentName:   cert.student.name,
        courseTitle:   cert.courseTitle,
        certificateId: cert.id,
        issuedAt:      cert.issuedAt,
        category:      cert.course.category,
      });
      const stored = await this.uploads.saveBuffer(buffer, 'certificates', `${cert.id}.pdf`);
      await this.prisma.certificate.update({
        where: { id: cert.id },
        data: { pdfUrl: stored.originUrl },
      });
      this.logger.log(`Re-generated missing PDF for certificate ${cert.id}`);
    }

    return { buffer, filename: `certificate-${cert.id}.pdf` };
  }

  /**
   * Public verification endpoint — checks both DB and on-chain state.
   * Issue #247: Returns tri-state result (valid/invalid/unverifiable/pending)
   * instead of conflating RPC errors with revocation.
   */
  async verify(certificateId: string) {
    const cert = await this.findPublicById(certificateId);

    // Check if certificate is revoked
    if (cert.isRevoked) {
      return {
        status: 'INVALID',
        valid: false,
        reason: 'revoked',
        certificate: null,
      };
    }

    // Check if certificate is pending (not yet issued on-chain)
    if (!cert.txHash) {
      return {
        status: 'PENDING',
        valid: false,
        reason: 'not_issued_on_chain_yet',
        certificate: null,
      };
    }

    // Cross-check with on-chain state
    const onChain = await this.stellar.verifyCertificateOnChain(certificateId);
    const onChainResult = typeof onChain === 'boolean' ? { valid: onChain, error: undefined } : onChain;

    if (onChainResult.error) {
      return {
        status: 'UNVERIFIABLE',
        valid: false,
        reason: 'rpc_error',
        details: onChainResult.error.message,
        certificate: null,
      };
    }

    if (!onChainResult.valid) {
      return {
        status: 'INVALID',
        valid: false,
        reason: 'not_found_on_chain',
        certificate: null,
      };
    }

    return { status: 'VALID', valid: true, certificate: cert };
  }

  async revoke(certificateId: string, adminId: string, reason?: string) {
    const cert = await this.findById(certificateId);
    if (cert.isRevoked) throw new ForbiddenException('Certificate already revoked');

    const updated = await this.prisma.certificate.update({
      where: { id: certificateId },
      data: {
        isRevoked: true,
        revokedById: adminId,
        revokedAt: new Date(),
        revokeReason: reason ?? null,
      },
    });

    await this.notifications.notifyUser(
      cert.studentId,
      NotificationType.CERTIFICATE_REVOKED,
      'Certificate Revoked',
      `Your certificate for "${cert.course?.title ?? 'your course'}" has been revoked.${reason ? ` Reason: ${reason}` : ''}`,
      { certificateId, reason },
    );

    return updated;
  }
}
