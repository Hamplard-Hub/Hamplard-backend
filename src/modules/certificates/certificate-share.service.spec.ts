import {
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CertificateShareService } from './certificate-share.service';

const mockPrisma = {
  certificate: { findUnique: jest.fn() },
  certificateShare: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
};

const configValues: Record<string, string> = {
  PUBLIC_API_URL: 'https://api.hamplard.test/api/v1',
  FRONTEND_URL: 'https://hamplard.test',
  PLATFORM_NAME: 'Hamplard',
};

const mockConfig = {
  get: jest.fn((key: string, fallback?: string) => configValues[key] ?? fallback),
};

const certificate = {
  id: 'CERT-ABC123',
  studentId: 'student-1',
  courseId: 'course-1',
  courseTitle: 'Professional Tailoring',
  instructorAddress: 'GINSTRUCTOR',
  txHash: null,
  isRevoked: false,
  issuedAt: new Date('2026-08-15T10:00:00.000Z'),
  student: { name: 'Jane Doe' },
  course: { thumbnailUrl: 'https://cdn.hamplard.test/tailoring.png' },
};

describe('CertificateShareService', () => {
  let service: CertificateShareService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificateShareService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(CertificateShareService);
    jest.clearAllMocks();
  });

  describe('generateShareLink()', () => {
    it('creates an idempotent share link and LinkedIn add-to-profile URL', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(certificate);
      mockPrisma.certificateShare.upsert.mockResolvedValue({
        id: 'share-1',
        certificateId: certificate.id,
        token: 'public-token',
        viewCount: 4,
      });

      const result = await service.generateShareLink(certificate.id, 'student-1');

      expect(mockPrisma.certificateShare.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { certificateId: certificate.id } }),
      );
      expect(result.shareUrl).toBe(
        'https://api.hamplard.test/api/v1/certificates/share/public-token',
      );
      expect(result.linkedinUrl).toContain('startTask=CERTIFICATION_NAME');
      expect(result.linkedinUrl).toContain('certId=CERT-ABC123');
      expect(result.linkedinMetadata).toEqual(
        expect.objectContaining({
          certificationName: 'Professional Tailoring',
          credentialId: 'CERT-ABC123',
          issueYear: 2026,
          issueMonth: 8,
        }),
      );
      expect(result.openGraph.image).toBe(certificate.course.thumbnailUrl);
      expect(result.viewCount).toBe(4);
    });

    it('rejects a missing certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(null);

      await expect(
        service.generateShareLink('missing', 'student-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects sharing another student\'s certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue(certificate);

      await expect(
        service.generateShareLink(certificate.id, 'student-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects a revoked certificate', async () => {
      mockPrisma.certificate.findUnique.mockResolvedValue({
        ...certificate,
        isRevoked: true,
      });

      await expect(
        service.generateShareLink(certificate.id, 'student-1'),
      ).rejects.toThrow(GoneException);
      expect(mockPrisma.certificateShare.upsert).not.toHaveBeenCalled();
    });
  });

  describe('renderSharePage()', () => {
    it('increments the counter and renders Open Graph metadata', async () => {
      mockPrisma.certificateShare.findUnique.mockResolvedValue({
        id: 'share-1',
        token: 'public-token',
        viewCount: 4,
        certificate,
      });
      mockPrisma.certificateShare.update.mockResolvedValue({
        id: 'share-1',
        token: 'public-token',
        viewCount: 5,
      });

      const result = await service.renderSharePage('public-token');

      expect(mockPrisma.certificateShare.update).toHaveBeenCalledWith({
        where: { id: 'share-1' },
        data: {
          viewCount: { increment: 1 },
          lastViewedAt: expect.any(Date),
        },
      });
      expect(result.viewCount).toBe(5);
      expect(result.html).toContain('<meta property="og:title"');
      expect(result.html).toContain('<meta property="og:image"');
      expect(result.html).toContain('Verify this certificate');
    });

    it('does not count a view after the certificate is revoked', async () => {
      mockPrisma.certificateShare.findUnique.mockResolvedValue({
        id: 'share-1',
        token: 'public-token',
        viewCount: 4,
        certificate: { ...certificate, isRevoked: true },
      });

      await expect(service.renderSharePage('public-token')).rejects.toThrow(
        GoneException,
      );
      expect(mockPrisma.certificateShare.update).not.toHaveBeenCalled();
    });
  });
});
