import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CertificateTemplatesService } from './certificate-templates.service';
import { PrismaService } from '../../common/prisma/prisma.service';
const NOW = new Date('2026-08-27T00:00:00.000Z');

const COMPLETE_BRANDING = {
  organizationName: 'Hamplard Academy',
  primaryColor: '#1A365D',
  secondaryColor: '#C9A227',
  footerText: 'Verify at hamplard.com',
};

const COMPLETE_LAYOUT = {
  orientation: 'LANDSCAPE' as const,
  titleText: 'Certificate of Completion',
  subtitleText: 'Tailoring',
  bodyText: 'This certifies that {{studentName}} has successfully completed {{courseTitle}}.',
  showIssueDate: true,
  showCertificateId: true,
};

const COMPLETE_SIGNATURES = [
  { name: 'Ada Lovelace', label: 'Director of Education', title: 'PhD' },
  { name: 'Kwame Nkrumah', label: 'Lead Instructor' },
];

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tmpl-1',
    name: 'Tailoring Classic',
    category: 'Tailoring',
    branding: COMPLETE_BRANDING,
    layout: COMPLETE_LAYOUT,
    signatures: COMPLETE_SIGNATURES,
    isActive: false,
    createdById: 'admin-1',
    activatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('CertificateTemplatesService', () => {
  let service: CertificateTemplatesService;

  const mockPrisma: any = {
    certificateTemplate: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificateTemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(CertificateTemplatesService);
    jest.clearAllMocks();
  });

  describe('create / configuration', () => {
    it('creates a draft template with branding, layout, and signatures', async () => {
      const row = makeRow();
      mockPrisma.certificateTemplate.create.mockResolvedValue(row);

      const result = await service.create('admin-1', {
        name: 'Tailoring Classic',
        category: 'Tailoring',
        branding: COMPLETE_BRANDING,
        layout: COMPLETE_LAYOUT,
        signatures: COMPLETE_SIGNATURES,
      });

      expect(result.isActive).toBe(false);
      expect(result.branding.organizationName).toBe('Hamplard Academy');
      expect(result.layout.orientation).toBe('LANDSCAPE');
      expect(result.signatures).toHaveLength(2);
      expect(mockPrisma.certificateTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdById: 'admin-1',
            isActive: false,
            category: 'Tailoring',
          }),
        }),
      );
    });

    it('allows saving an incomplete draft for later configuration', async () => {
      mockPrisma.certificateTemplate.create.mockResolvedValue(
        makeRow({ branding: {}, layout: {}, signatures: [] }),
      );

      const result = await service.create('admin-1', {
        name: 'WIP',
        category: 'Baking',
      });

      expect(result.isActive).toBe(false);
      expect(result.signatures).toEqual([]);
    });

    it('merges branding and layout on update', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(makeRow());
      mockPrisma.certificateTemplate.update.mockResolvedValue(
        makeRow({ branding: { ...COMPLETE_BRANDING, primaryColor: '#0F172A' } }),
      );

      const result = await service.update('tmpl-1', {
        branding: { primaryColor: '#0F172A' },
      });

      expect(result.branding.primaryColor).toBe('#0F172A');
      expect(mockPrisma.certificateTemplate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            branding: expect.objectContaining({
              organizationName: 'Hamplard Academy',
              primaryColor: '#0F172A',
            }),
          }),
        }),
      );
    });
  });

  describe('validation', () => {
    it('reports all missing required fields', () => {
      const result = service.validateRequiredFields({
        branding: {},
        layout: {},
        signatures: [],
      });

      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(expect.arrayContaining([
        'branding.organizationName',
        'branding.primaryColor',
        'layout.orientation',
        'layout.titleText',
        'layout.bodyText',
        'signatures',
      ]));
    });

    it('treats a complete template as valid', () => {
      const result = service.validateRequiredFields({
        branding: COMPLETE_BRANDING,
        layout: COMPLETE_LAYOUT,
        signatures: COMPLETE_SIGNATURES,
      });

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('flags incomplete signature entries', () => {
      const result = service.validateRequiredFields({
        branding: COMPLETE_BRANDING,
        layout: COMPLETE_LAYOUT,
        signatures: [{ name: 'Ada' }],
      });

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('signatures[0].label');
    });
  });

  describe('activation', () => {
    it('activates a complete template and deactivates the previous one for the category', async () => {
      const draft = makeRow();
      const activated = makeRow({ isActive: true, activatedAt: NOW });
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(draft);
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
        return fn({
          certificateTemplate: {
            updateMany: mockPrisma.certificateTemplate.updateMany.mockResolvedValue({ count: 1 }),
            update: mockPrisma.certificateTemplate.update.mockResolvedValue(activated),
          },
        });
      });

      const result = await service.activate('tmpl-1');

      expect(result.isActive).toBe(true);
      expect(mockPrisma.certificateTemplate.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
            id: { not: 'tmpl-1' },
          }),
          data: { isActive: false },
        }),
      );
    });

    it('rejects activation when required fields are missing', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(
        makeRow({ branding: {}, layout: {}, signatures: [] }),
      );

      await expect(service.activate('tmpl-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when activating a missing template', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(null);
      await expect(service.activate('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blocks incomplete updates to an already-active template', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(
        makeRow({ isActive: true }),
      );

      await expect(
        service.update('tmpl-1', { branding: { organizationName: '' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to delete the active template', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(
        makeRow({ isActive: true }),
      );

      await expect(service.remove('tmpl-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.certificateTemplate.delete).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('renders a PDF preview for a draft template before activation', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(
        makeRow({ isActive: false, branding: { organizationName: 'Preview Org' } }),
      );

      const buffer = await service.preview('tmpl-1', { studentName: 'Amina Bello' });

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(buffer.length).toBeGreaterThan(100);
    });

    it('throws NotFoundException when previewing a missing template', async () => {
      mockPrisma.certificateTemplate.findUnique.mockResolvedValue(null);
      await expect(service.preview('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getActiveTemplateForCategory', () => {
    it('returns the active template for a category', async () => {
      mockPrisma.certificateTemplate.findFirst.mockResolvedValue(
        makeRow({ isActive: true, activatedAt: NOW }),
      );

      const result = await service.getActiveTemplateForCategory('Tailoring');
      expect(result.isActive).toBe(true);
      expect(result.category).toBe('Tailoring');
    });

    it('throws when no active template exists for the category', async () => {
      mockPrisma.certificateTemplate.findFirst.mockResolvedValue(null);
      await expect(service.getActiveTemplateForCategory('Makeup'))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
