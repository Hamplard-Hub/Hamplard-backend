import { Test, TestingModule } from '@nestjs/testing';
import { CertificatesService } from './certificates.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

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
      ],
    }).compile();

    service = module.get<CertificatesService>(CertificatesService);
    jest.clearAllMocks();
  });

  describe('issue()', () => {
    it('issues a certificate for a completed enrollment', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(MOCK_ENROLLMENT);
      mockPrisma.certificate.findFirst.mockResolvedValue(null);
      mockPrisma.certificate.create.mockResolvedValue({
        id:              'CERT-ABC123',
        studentId:       'student-1',
        courseId:        'COURSE-TAILORING-001',
        courseTitle:     'Professional Tailoring',
        instructorAddress:'GXYZ',
        isRevoked:       false,
        issuedAt:        new Date(),
        student:         MOCK_ENROLLMENT.student,
        course:          MOCK_ENROLLMENT.course,
      });

      const result = await service.issue('admin-1', 'student-1', 'COURSE-TAILORING-001');
      expect(result.courseTitle).toBe('Professional Tailoring');
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
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Makeup', instructor: { name: 'MUA' } },
      });
      mockStellar.verifyCertificateOnChain.mockResolvedValue(false);

      const result = await service.verify('CERT-NO-CHAIN');
      expect(result.valid).toBe(false);
    });
  });

  describe('revoke()', () => {
    it('revokes a valid certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-ABC123',
        isRevoked: false,
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Tailoring', instructor: { name: 'John' } },
      });
      mockPrisma.certificate.update.mockResolvedValue({ id: 'CERT-ABC123', isRevoked: true });

      const result = await service.revoke('CERT-ABC123', 'admin-1');
      expect(result.isRevoked).toBe(true);
    });

    it('throws ForbiddenException if already revoked', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        id: 'CERT-ALREADY',
        isRevoked: true,
        student: { name: 'Jane', stellarAddress: 'GABC' },
        course:  { title: 'Tailoring', instructor: { name: 'John' } },
      });
      await expect(service.revoke('CERT-ALREADY', 'admin-1'))
        .rejects.toThrow(ForbiddenException);
    });
  });
});
