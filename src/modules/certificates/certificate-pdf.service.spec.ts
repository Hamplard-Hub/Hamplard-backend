import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CertificatePdfService } from './certificate-pdf.service';
import { CertificateTemplatesService } from './certificate-templates.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const ACTIVE_TEMPLATE = {
  id: 'tmpl-active',
  name: 'Baking Landscape',
  category: 'Baking',
  branding: {
    organizationName: 'Hamplard Academy',
    primaryColor: '#7C2D12',
    secondaryColor: '#F59E0B',
  },
  layout: {
    orientation: 'LANDSCAPE',
    titleText: 'Certificate of Completion',
    bodyText: 'Awarded to {{studentName}} for completing {{courseTitle}}.',
    showIssueDate: true,
    showCertificateId: true,
  },
  signatures: [{ name: 'Chef Amina', label: 'Head of Culinary' }],
  isActive: true,
  createdById: 'admin-1',
  activatedAt: new Date('2026-08-01T00:00:00.000Z'),
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('CertificatePdfService', () => {
  let pdfService: CertificatePdfService;
  let templatesService: CertificateTemplatesService;

  const mockPrisma: any = {
    certificateTemplate: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificatePdfService,
        CertificateTemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    pdfService = module.get(CertificatePdfService);
    templatesService = module.get(CertificateTemplatesService);
    jest.clearAllMocks();
  });

  it('loads the active template for the course category', async () => {
    mockPrisma.certificateTemplate.findFirst.mockResolvedValue(ACTIVE_TEMPLATE);

    const template = await pdfService.getActiveTemplate('Baking');

    expect(template.id).toBe('tmpl-active');
    expect(template.branding.organizationName).toBe('Hamplard Academy');
    expect(mockPrisma.certificateTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          category: { equals: 'Baking', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('renders a certificate PDF using the active template configuration', async () => {
    mockPrisma.certificateTemplate.findFirst.mockResolvedValue(ACTIVE_TEMPLATE);

    const buffer = await pdfService.renderForCategory('Baking', {
      studentName: 'Chinedu Okafor',
      courseTitle: 'Artisan Bread',
      certificateId: 'CERT-BAKE-001',
      issuedAt: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(200);
  });

  it('does not render when the category has no active template', async () => {
    mockPrisma.certificateTemplate.findFirst.mockResolvedValue(null);

    await expect(
      pdfService.renderForCategory('Photography', {
        studentName: 'Test',
        courseTitle: 'Test',
        certificateId: 'CERT-X',
        issuedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an active template that fails required-field validation', async () => {
    mockPrisma.certificateTemplate.findFirst.mockResolvedValue({
      ...ACTIVE_TEMPLATE,
      branding: {},
      layout: {},
      signatures: [],
    });

    await expect(pdfService.getActiveTemplate('Baking')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses CertificateTemplatesService as the source of the active template', async () => {
    const spy = jest
      .spyOn(templatesService, 'getActiveTemplateForCategory')
      .mockResolvedValue(ACTIVE_TEMPLATE as any);
    jest.spyOn(templatesService, 'renderPdf').mockResolvedValue(Buffer.from('%PDF-fake'));

    await pdfService.renderForCategory('Baking', {
      studentName: 'Amina',
      courseTitle: 'Pastry',
      certificateId: 'CERT-1',
      issuedAt: new Date(),
    });

    expect(spy).toHaveBeenCalledWith('Baking');
    expect(templatesService.renderPdf).toHaveBeenCalledWith(
      ACTIVE_TEMPLATE,
      expect.objectContaining({ studentName: 'Amina', category: 'Baking' }),
    );
  });
});
