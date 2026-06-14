import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Issue a certificate for a student who has completed a course.
   *
   * Flow:
   *  1. Verify the student's enrollment is COMPLETED (100% progress)
   *  2. Verify no certificate already exists
   *  3. Store the certificate record in the DB
   *  4. The frontend/admin wallet then calls issue_certificate() on-chain
   *     and sends back the txHash to update the DB record
   *  5. Notify the student
   *
   * In production, step 4 should be automated via a secure backend signing
   * service that holds the admin keypair and calls the contract directly.
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

    // Check for existing certificate
    const existing = await this.prisma.certificate.findFirst({
      where: { studentId, courseId },
    });
    if (existing) throw new ForbiddenException('Certificate already issued for this enrollment');

    // Generate a unique certificate ID
    const certificateId = `CERT-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

    // Create DB record
    const certificate = await this.prisma.certificate.create({
      data: {
        id:                certificateId,
        studentId,
        courseId,
        courseTitle:       enrollment.course.title,
        instructorAddress: enrollment.course.instructorAddress,
      },
      include: { student: true, course: true },
    });

    // Notify student
    await this.notifications.notifyUser(
      studentId,
      NotificationType.CERTIFICATE_ISSUED,
      '🎓 Certificate issued!',
      `Congratulations! Your certificate for "${enrollment.course.title}" has been issued. You can now share it with employers and clients.`,
      { certificateId, courseId },
    );

    this.logger.log(`Certificate issued: ${certificateId} for student ${studentId}`);
    return certificate;
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

  async findById(certificateId: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: {
        student: { select: { name: true, stellarAddress: true } },
        course:  { include: { instructor: { select: { name: true, stellarAddress: true } } } },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return cert;
  }

  /**
   * Public verification endpoint — checks both DB and on-chain state.
   * Returns the certificate details if valid, or an error if revoked/not found.
   */
  async verify(certificateId: string) {
    const cert = await this.findById(certificateId);

    if (cert.isRevoked) {
      return { valid: false, reason: 'Certificate has been revoked', certificate: null };
    }

    // Cross-check with on-chain state
    const onChainValid = await this.stellar.verifyCertificateOnChain(certificateId);
    if (!onChainValid) {
      return {
        valid: false,
        reason: 'Certificate not found or revoked on-chain',
        certificate: null,
      };
    }

    return { valid: true, certificate: cert };
  }

  async revoke(certificateId: string, adminId: string) {
    const cert = await this.findById(certificateId);
    if (cert.isRevoked) throw new ForbiddenException('Certificate already revoked');

    return this.prisma.certificate.update({
      where: { id: certificateId },
      data: { isRevoked: true },
    });
  }
}
