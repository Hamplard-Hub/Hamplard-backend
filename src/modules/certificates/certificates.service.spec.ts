import { Test, TestingModule } from '@nestjs/testing';
import { CertificatesService, PUBLIC_CERTIFICATE_SELECT } from './certificates.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExamsService } from '../exams/exams.service';
import { CertificatePdfService } from './certificate-pdf.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UploadsService } from '../uploads/uploads.service';

const mockPrisma = {
  enrollment: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  certificate: {
    findFirst:  jest.fn(),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    updateMany: jest.fn(),
    findMany:   jest.fn(),
  },
  user: { findUnique: jest.fn() },
};

const mockStellar = {
  verifyCertificateOnChain: jest.fn().mockResolvedValue(true),
};

const mockNotifications = {
  notifyUser: jest.fn().mockResolvedValue({}),
};

const mockExams = {
  hasPassedExam: jest.fn().mockResolvedValue(true),
};

const mockPdf = {
  renderForCategory: jest.fn().mockResolvedValue(Buffer.from('%PDF-mock')),
};

const mockUploads = {
  saveBuffer: jest.fn(async (_buf: Buffer, subfolder: string, filename: string) => ({
    originUrl: `/uploads/${subfolder}/${filename}`,
  })),
  readStoredFile: jest.fn(),
};

const MOCK_ENROLLMENT = {
  id:             'enroll-1',
  studentId:      'student-1',
  courseId:       'COURSE-TAILORING-001',
  status:         'COMPLETED',
  progressPercent:100,
  amountPaid:     50,
  student:        { id: 'student-1', name: 'Jane', email: 'jane@test.com', stellarAddress: 'GABC' },
  course:         { id: 'COURSE-TAILORING-001', title: 'Professional Tailoring', instructorAddress: 'GXYZ' },
};

describe('CertificatesService', () => {
  let service: CertificatesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificatesService,
        { provide: PrismaService,        useValue: mockPrisma },
        { provide: StellarService,       useValue: mockStellar },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: ExamsService,         useValue: mockExams },
        { provide: CertificatePdfService, useValue: mockPdf },
        { provide: UploadsService,        useValue: mockUploads },
      ],
    }).compile();

    service = module.get<CertificatesService>(CertificatesService);
    jest.clearAllMocks();
  });

  describe('issue()', () => {
    it('issues a certificate for a completed enrollment', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(MOCK_ENROLLMENT);
      mockPrisma.certificate.findFirst.mockResolvedValue(null);
      const created = {
        id:              'CERT-ABC123',
        studentId:       'student-1',
        courseId:        'COURSE-TAILORING-001',
        courseTitle:     'Professional Tailoring',
        instructorAddress:'GXYZ',
        isRevoked:       false,
        issuedAt:        new Date(),
        student:         MOCK_ENROLLMENT.student,
        course:          MOCK_ENROLLMENT.course,
      };
      mockPrisma.certificate.create.mockResolvedValue(created);
      // issue() renders the PDF and returns the row updated with its pdfUrl
      mockPrisma.certificate.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...created, ...data }),
      );

      const result = await service.issue('admin-1', 'student-1', 'COURSE-TAILORING-001');
      expect(result.courseTitle).toBe('Professional Tailoring');
      expect(mockPdf.renderForCategory).toHaveBeenCalledTimes(1);
      expect(result.pdfUrl).toMatch(/^\/uploads\/certificates\/CERT-.+\.pdf$/);
      // Issue #245 — the rendered bytes are actually persisted
      expect(mockUploads.saveBuffer).toHaveBeenCalledWith(
        Buffer.from('%PDF-mock'),
        'certificates',
        expect.stringMatching(/^CERT-.+\.pdf$/),
      );
      expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(1);
    });

    it('throws ForbiddenException if course not completed', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        ...MOCK_ENROLLMENT,
        status: 'ACTIVE',
        progressPercent: 60,
      });
      await expect(service.issue('admin-1', 'student-1', 'COURSE-TAILORING-001'))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException if certificate already issued', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(MOCK_ENROLLMENT);
      mockPrisma.certificate.findFirst.mockResolvedValue({ id: 'CERT-EXISTS' });
      await expect(service.issue('admin-1', 'student-1', 'COURSE-TAILORING-001'))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if enrollment not found', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);
      await expect(service.issue('admin-1', 'student-1', 'MISSING-COURSE'))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('verify()', () => {
    it('returns valid=true for a valid certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-ABC123',
        isRevoked: false,
        txHash: 'tx-abc',
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Professional Tailoring', instructor: { name: 'John' } },
      });
      mockStellar.verifyCertificateOnChain.mockResolvedValue(true);

      const result = await service.verify('CERT-ABC123');
      expect(result.valid).toBe(true);
      expect(result.certificate).not.toBeNull();
    });

    it('returns valid=false for a revoked certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-REVOKED',
        isRevoked: true,
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Baking', instructor: { name: 'Chef' } },
      });

      const result = await service.verify('CERT-REVOKED');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    it('returns valid=false if not found on-chain', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-NO-CHAIN',
        isRevoked: false,
        txHash: 'tx-abc',
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Makeup', instructor: { name: 'MUA' } },
      });
      mockStellar.verifyCertificateOnChain.mockResolvedValue(false);

      const result = await service.verify('CERT-NO-CHAIN');
      expect(result.valid).toBe(false);
    });
  });

  describe('revoke()', () => {
    it('revokes a valid certificate and records audit trail and sends notification', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-ABC123',
        studentId: 'student-1',
        isRevoked: false,
        student: { id: 'student-1', name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Tailoring', instructor: { name: 'John' } },
      });
      mockPrisma.certificate.update.mockResolvedValue({
        id: 'CERT-ABC123',
        isRevoked: true,
        revokedById: 'admin-1',
        revokeReason: 'Fraudulent activity',
      });

      const result = await service.revoke('CERT-ABC123', 'admin-1', 'Fraudulent activity');
      expect(result.isRevoked).toBe(true);
      expect(mockPrisma.certificate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'CERT-ABC123' },
          data: expect.objectContaining({
            isRevoked: true,
            revokedById: 'admin-1',
            revokeReason: 'Fraudulent activity',
          }),
        }),
      );
      expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
        'student-1',
        'CERTIFICATE_REVOKED',
        'Certificate Revoked',
        expect.stringContaining('Fraudulent activity'),
        { certificateId: 'CERT-ABC123', reason: 'Fraudulent activity' },
      );
    });

    it('throws ForbiddenException if already revoked', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-ALREADY',
        studentId: 'student-1',
        isRevoked: true,
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Tailoring', instructor: { name: 'John' } },
      });
      await expect(service.revoke('CERT-ALREADY', 'admin-1'))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ----------------------------------------------------------
  // Issue #245 — owner-restricted PDF download
  // ----------------------------------------------------------

  describe('getPdfForDownload()', () => {
    const CERT = {
      id:          'CERT-ABC123',
      studentId:   'student-1',
      courseTitle: 'Professional Tailoring',
      issuedAt:    new Date('2026-01-01T00:00:00Z'),
      pdfUrl:      '/uploads/certificates/CERT-ABC123.pdf',
      isRevoked:   false,
      student:     { id: 'student-1', name: 'Jane', stellarAddress: 'GABC' },
      course:      { id: 'COURSE-TAILORING-001', category: 'Tailoring', title: 'Professional Tailoring' },
    };
    const PDF = Buffer.from('%PDF-1.4 stored');
    const HOLDER = { id: 'student-1', stellarAddress: 'GABC', role: UserRole.STUDENT };

    beforeEach(() => {
      mockPrisma.certificate.findUnique.mockResolvedValue(CERT);
      mockUploads.readStoredFile.mockReturnValue(PDF);
    });

    it('returns the stored PDF to the certificate holder', async () => {
      const result = await service.getPdfForDownload('CERT-ABC123', HOLDER);

      expect(result).toEqual({ buffer: PDF, filename: 'certificate-CERT-ABC123.pdf' });
      expect(mockUploads.readStoredFile).toHaveBeenCalledWith(CERT.pdfUrl);
      expect(mockPdf.renderForCategory).not.toHaveBeenCalled();
    });

    it('matches the holder by wallet address too', async () => {
      await expect(
        service.getPdfForDownload('CERT-ABC123', {
          id: 'other-id', stellarAddress: 'GABC', role: UserRole.STUDENT,
        }),
      ).resolves.toEqual(expect.objectContaining({ buffer: PDF }));
    });

    it('allows an admin', async () => {
      await expect(
        service.getPdfForDownload('CERT-ABC123', {
          id: 'admin-1', stellarAddress: null, role: UserRole.ADMIN,
        }),
      ).resolves.toEqual(expect.objectContaining({ buffer: PDF }));
    });

    it.each([
      ['another student', { id: 'student-2', stellarAddress: 'GOTHER', role: UserRole.STUDENT }],
      ['the course instructor', { id: 'inst-1', stellarAddress: 'GXYZ', role: UserRole.INSTRUCTOR }],
    ])('throws ForbiddenException for %s without reading the file', async (_label, user) => {
      await expect(service.getPdfForDownload('CERT-ABC123', user))
        .rejects.toThrow(ForbiddenException);
      expect(mockUploads.readStoredFile).not.toHaveBeenCalled();
    });

    it('re-renders and stores the PDF when the file is missing (legacy record)', async () => {
      mockUploads.readStoredFile.mockReturnValue(null);
      mockPrisma.certificate.update.mockResolvedValue({});

      const result = await service.getPdfForDownload('CERT-ABC123', HOLDER);

      expect(mockPdf.renderForCategory).toHaveBeenCalledWith(
        'Tailoring',
        expect.objectContaining({ studentName: 'Jane', certificateId: 'CERT-ABC123' }),
      );
      expect(mockUploads.saveBuffer).toHaveBeenCalledWith(
        result.buffer, 'certificates', 'CERT-ABC123.pdf',
      );
      expect(mockPrisma.certificate.update).toHaveBeenCalledWith({
        where: { id: 'CERT-ABC123' },
        data: { pdfUrl: '/uploads/certificates/CERT-ABC123.pdf' },
      });
    });

    it('throws NotFoundException for an unknown certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(null);
      await expect(
        service.getPdfForDownload('MISSING', { id: 'admin-1', role: UserRole.ADMIN }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('public lookups hide admin PII (issue #246)', () => {
    const PUBLIC_ROW = {
      id: 'CERT-REVOKED',
      courseId: 'COURSE-TAILORING-001',
      courseTitle: 'Professional Tailoring',
      instructorAddress: 'GXYZ',
      txHash: 'tx-1',
      isRevoked: true,
      revokedAt: new Date('2026-02-01T00:00:00Z'),
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      student: { name: 'Jane', stellarAddress: 'GABC' },
      course: {
        id: 'COURSE-TAILORING-001',
        title: 'Professional Tailoring',
        category: 'Tailoring',
        level: 'Beginner',
        thumbnailUrl: null,
        instructor: { name: 'John', stellarAddress: 'GXYZ' },
      },
    };

    it('the public projection never selects revokedBy, revokedById or the admin email', () => {
      expect(PUBLIC_CERTIFICATE_SELECT).not.toHaveProperty('revokedBy');
      expect(PUBLIC_CERTIFICATE_SELECT).not.toHaveProperty('revokedById');
      expect(PUBLIC_CERTIFICATE_SELECT).not.toHaveProperty('studentId');
      expect(JSON.stringify(PUBLIC_CERTIFICATE_SELECT)).not.toContain('email');
    });

    it('findPublicById() queries with the public projection and exposes only isRevoked', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(PUBLIC_ROW);

      const cert = await service.findPublicById('CERT-REVOKED');

      expect(mockPrisma.certificate.findUnique).toHaveBeenCalledWith({
        where: { id: 'CERT-REVOKED' },
        select: PUBLIC_CERTIFICATE_SELECT,
      });
      expect(cert.isRevoked).toBe(true);
      expect(cert).not.toHaveProperty('revokedBy');
      expect(cert).not.toHaveProperty('revokedById');
    });

    it('findPublicById() throws NotFoundException for an unknown certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(null);
      await expect(service.findPublicById('MISSING')).rejects.toThrow(NotFoundException);
    });

    it('verify() uses the public projection, so revokedBy.email / revokedBy.id never load', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({ ...PUBLIC_ROW, isRevoked: false });
      mockStellar.verifyCertificateOnChain.mockResolvedValue(true);

      const result = await service.verify('CERT-REVOKED');

      const query = mockPrisma.certificate.findUnique.mock.calls[0][0];
      expect(query.select).toBe(PUBLIC_CERTIFICATE_SELECT);
      expect(query).not.toHaveProperty('include');
      expect(result.valid).toBe(true);
      expect(result.certificate).not.toHaveProperty('revokedBy');
      expect(JSON.stringify(result)).not.toContain('email');
    });

    it('findById() (admin/internal) still loads revokedBy details', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        ...PUBLIC_ROW,
        revokedBy: { id: 'admin-1', name: 'Admin', email: 'admin@hamplard.io' },
      });

      await service.findById('CERT-REVOKED');

      expect(mockPrisma.certificate.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            revokedBy: { select: { id: true, name: true, email: true } },
          }),
        }),
      );
    });
  });
});
