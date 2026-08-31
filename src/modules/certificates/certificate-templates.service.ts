import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import PDFDocument = require('pdfkit');
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CreateCertificateTemplateDto,
  PreviewCertificateTemplateDto,
  QueryCertificateTemplatesDto,
  UpdateCertificateTemplateDto,
} from './dto/certificate-template.dto';
import {
  CertificateBranding,
  CertificateLayout,
  CertificateRenderData,
  CertificateSignature,
  CertificateTemplateConfig,
  HEX_COLOR_PATTERN,
  REQUIRED_BRANDING_FIELDS,
  REQUIRED_LAYOUT_FIELDS,
  REQUIRED_SIGNATURE_FIELDS,
  TemplateValidationResult,
  VALID_ORIENTATIONS,
} from './certificate-template.types';

@Injectable()
export class CertificateTemplatesService {
  private readonly logger = new Logger(CertificateTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(adminId: string, dto: CreateCertificateTemplateDto) {
    const template = await this.prisma.certificateTemplate.create({
      data: {
        name: dto.name.trim(),
        category: dto.category.trim(),
        branding: (dto.branding ?? {}) as unknown as Prisma.InputJsonValue,
        layout: (dto.layout ?? {}) as unknown as Prisma.InputJsonValue,
        signatures: (dto.signatures ?? []) as unknown as Prisma.InputJsonValue,
        createdById: adminId,
        isActive: false,
      },
    });

    this.logger.log(`Certificate template created: ${template.id} (${template.category}) by admin ${adminId}`);
    return this.toConfig(template);
  }

  async findAll(query: QueryCertificateTemplatesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.CertificateTemplateWhereInput = {};
    if (query.category) {
      where.category = { equals: query.category.trim(), mode: 'insensitive' };
    }
    if (typeof query.isActive === 'boolean') {
      where.isActive = query.isActive;
    }

    const [data, total] = await Promise.all([
      this.prisma.certificateTemplate.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.certificateTemplate.count({ where }),
    ]);

    return {
      data: data.map((row) => this.toConfig(row)),
      total,
      page,
      limit,
    };
  }

  async findOne(id: string) {
    return this.toConfig(await this.findOrThrow(id));
  }

  /**
   * Returns the currently active, validated template for a course category.
   * Used by the PDF generation service when rendering issued certificates.
   */
  async getActiveTemplateForCategory(category: string): Promise<CertificateTemplateConfig> {
    const template = await this.prisma.certificateTemplate.findFirst({
      where: {
        isActive: true,
        category: { equals: category.trim(), mode: 'insensitive' },
      },
    });

    if (!template) {
      throw new NotFoundException(
        `No active certificate template is configured for category "${category}"`,
      );
    }

    const config = this.toConfig(template);
    const validation = this.validateRequiredFields(config);
    if (!validation.valid) {
      throw new BadRequestException(
        `Active template ${template.id} is missing required fields: ${validation.missing.join(', ')}`,
      );
    }

    return config;
  }

  async update(id: string, dto: UpdateCertificateTemplateDto) {
    const existing = await this.findOrThrow(id);
    const nextBranding = {
      ...this.asBranding(existing.branding),
      ...(dto.branding ?? {}),
    };
    const nextLayout = {
      ...this.asLayout(existing.layout),
      ...(dto.layout ?? {}),
    };
    const nextSignatures = dto.signatures ?? this.asSignatures(existing.signatures);
    const nextCategory = dto.category?.trim() ?? existing.category;
    const nextName = dto.name?.trim() ?? existing.name;

    const merged: CertificateTemplateConfig = {
      ...this.toConfig(existing),
      name: nextName,
      category: nextCategory,
      branding: nextBranding,
      layout: nextLayout,
      signatures: nextSignatures,
    };

    if (existing.isActive) {
      const validation = this.validateRequiredFields(merged);
      if (!validation.valid) {
        throw new BadRequestException(
          `Cannot save an incomplete configuration on an active template. Missing: ${validation.missing.join(', ')}`,
        );
      }
    }

    const updated = await this.prisma.certificateTemplate.update({
      where: { id },
      data: {
        name: nextName,
        category: nextCategory,
        branding: nextBranding as unknown as Prisma.InputJsonValue,
        layout: nextLayout as unknown as Prisma.InputJsonValue,
        signatures: nextSignatures as unknown as Prisma.InputJsonValue,
      },
    });

    return this.toConfig(updated);
  }

  async remove(id: string) {
    const existing = await this.findOrThrow(id);
    if (existing.isActive) {
      throw new ForbiddenException(
        'Cannot delete the active template for a category. Activate a replacement or deactivate it first.',
      );
    }

    await this.prisma.certificateTemplate.delete({ where: { id } });
    return { deleted: true, id };
  }

  /**
   * Activates a template for its course category after required-field validation.
   * Any previously active template for the same category is deactivated.
   */
  async activate(id: string) {
    const existing = await this.findOrThrow(id);
    const config = this.toConfig(existing);
    const validation = this.validateRequiredFields(config);

    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Template is missing required fields and cannot be activated',
        missing: validation.missing,
      });
    }

    const activated = await this.prisma.$transaction(async (tx) => {
      await tx.certificateTemplate.updateMany({
        where: {
          isActive: true,
          category: { equals: existing.category, mode: 'insensitive' },
          id: { not: id },
        },
        data: { isActive: false },
      });

      return tx.certificateTemplate.update({
        where: { id },
        data: { isActive: true, activatedAt: new Date() },
      });
    });

    this.logger.log(`Certificate template ${id} activated for category "${existing.category}"`);
    return this.toConfig(activated);
  }

  async deactivate(id: string) {
    const existing = await this.findOrThrow(id);
    if (!existing.isActive) {
      return this.toConfig(existing);
    }

    const updated = await this.prisma.certificateTemplate.update({
      where: { id },
      data: { isActive: false },
    });

    return this.toConfig(updated);
  }

  /**
   * Renders a preview PDF from the stored template without activating it.
   * Missing copy falls back to placeholders so admins can preview drafts.
   */
  async preview(id: string, dto: PreviewCertificateTemplateDto = {}): Promise<Buffer> {
    const template = this.toConfig(await this.findOrThrow(id));
    return this.renderPdf(template, {
      studentName: dto.studentName ?? 'Jane Okonkwo',
      courseTitle: dto.courseTitle ?? 'Professional Skills Course',
      certificateId: dto.certificateId ?? 'CERT-PREVIEW',
      issuedAt: new Date(),
      category: template.category,
    });
  }

  validateRequiredFields(template: Pick<CertificateTemplateConfig, 'branding' | 'layout' | 'signatures'>): TemplateValidationResult {
    const missing: string[] = [];
    const branding = template.branding ?? {};
    const layout = template.layout ?? {};
    const signatures = Array.isArray(template.signatures) ? template.signatures : [];

    for (const field of REQUIRED_BRANDING_FIELDS) {
      if (!this.hasText(branding[field])) missing.push(`branding.${field}`);
    }
    if (branding.primaryColor && !HEX_COLOR_PATTERN.test(branding.primaryColor)) {
      missing.push('branding.primaryColor');
    }

    for (const field of REQUIRED_LAYOUT_FIELDS) {
      if (!this.hasText(layout[field] as string | undefined)) missing.push(`layout.${field}`);
    }
    if (layout.orientation && !VALID_ORIENTATIONS.includes(layout.orientation)) {
      missing.push('layout.orientation');
    }

    if (signatures.length === 0) {
      missing.push('signatures');
    } else {
      signatures.forEach((signature, index) => {
        for (const field of REQUIRED_SIGNATURE_FIELDS) {
          if (!this.hasText(signature[field])) {
            missing.push(`signatures[${index}].${field}`);
          }
        }
      });
    }

    return { valid: missing.length === 0, missing };
  }

  renderPdf(template: CertificateTemplateConfig, data: CertificateRenderData): Promise<Buffer> {
    const branding = template.branding ?? {};
    const layout = template.layout ?? {};
    const signatures = Array.isArray(template.signatures) ? template.signatures : [];
    const isLandscape = (layout.orientation ?? 'LANDSCAPE') === 'LANDSCAPE';
    const size: [number, number] = isLandscape ? [842, 595] : [595, 842];
    const margin = layout.margin ?? 48;
    const primary = branding.primaryColor && HEX_COLOR_PATTERN.test(branding.primaryColor)
      ? branding.primaryColor
      : '#1A365D';
    const secondary = branding.secondaryColor && HEX_COLOR_PATTERN.test(branding.secondaryColor)
      ? branding.secondaryColor
      : '#C9A227';
    const organization = branding.organizationName || 'Hamplard';
    const title = layout.titleText || 'Certificate of Completion';
    const subtitle = layout.subtitleText || template.category;
    const body = this.interpolate(layout.bodyText || 'This certifies that {{studentName}} has successfully completed {{courseTitle}}.', {
      studentName: data.studentName,
      courseTitle: data.courseTitle,
      certificateId: data.certificateId,
      issueDate: data.issuedAt.toDateString(),
      category: data.category ?? template.category,
      organizationName: organization,
    });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size, margin, info: { Title: title, Author: organization } });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      doc.save();
      doc.lineWidth(4).strokeColor(primary);
      doc.rect(18, 18, pageWidth - 36, pageHeight - 36).stroke();
      doc.lineWidth(1).strokeColor(secondary);
      doc.rect(26, 26, pageWidth - 52, pageHeight - 52).stroke();
      doc.restore();

      doc.fillColor(primary).fontSize(14).text(organization, { align: 'center' });
      if (subtitle) {
        doc.moveDown(0.3);
        doc.fillColor(secondary).fontSize(10).text(subtitle, { align: 'center' });
      }

      doc.moveDown(1.4);
      doc.fillColor(primary).fontSize(26).text(title, { align: 'center' });

      doc.moveDown(1.2);
      doc.fillColor('#222').fontSize(12).text(body, { align: 'center', lineGap: 4 });

      doc.moveDown(0.8);
      doc.fillColor(primary).fontSize(18).text(data.studentName, { align: 'center' });
      doc.fillColor('#444').fontSize(12).text(data.courseTitle, { align: 'center' });

      if (layout.showIssueDate !== false) {
        doc.moveDown(0.6);
        doc.fontSize(10).fillColor('#555').text(`Issued: ${data.issuedAt.toDateString()}`, { align: 'center' });
      }
      if (layout.showCertificateId !== false) {
        doc.fontSize(10).fillColor('#555').text(`Certificate ID: ${data.certificateId}`, { align: 'center' });
      }

      const usableWidth = pageWidth - margin * 2;
      const signatureCount = Math.max(signatures.length, 0);
      if (signatureCount > 0) {
        const slotWidth = usableWidth / signatureCount;
        const y = pageHeight - margin - 70;
        signatures.forEach((signature, index) => {
          const x = margin + slotWidth * index;
          doc.strokeColor(primary).moveTo(x + 16, y).lineTo(x + slotWidth - 16, y).stroke();
          doc.fillColor('#111').fontSize(11).text(signature.name || '', x, y + 8, {
            width: slotWidth,
            align: 'center',
          });
          const role = [signature.label, signature.title].filter(Boolean).join(' · ');
          doc.fillColor('#666').fontSize(9).text(role, x, y + 24, {
            width: slotWidth,
            align: 'center',
          });
        });
      }

      if (branding.footerText) {
        doc.fillColor('#888').fontSize(8).text(branding.footerText, margin, pageHeight - margin + 8, {
          width: usableWidth,
          align: 'center',
        });
      }

      doc.end();
    });
  }

  private async findOrThrow(id: string) {
    const template = await this.prisma.certificateTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException(`Certificate template ${id} not found`);
    return template;
  }

  private toConfig(row: {
    id: string;
    name: string;
    category: string;
    branding: Prisma.JsonValue;
    layout: Prisma.JsonValue;
    signatures: Prisma.JsonValue;
    isActive: boolean;
    createdById: string;
    activatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): CertificateTemplateConfig {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      branding: this.asBranding(row.branding),
      layout: this.asLayout(row.layout),
      signatures: this.asSignatures(row.signatures),
      isActive: row.isActive,
      createdById: row.createdById,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private asBranding(value: Prisma.JsonValue): CertificateBranding {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as CertificateBranding)
      : {};
  }

  private asLayout(value: Prisma.JsonValue): CertificateLayout {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as CertificateLayout)
      : {};
  }

  private asSignatures(value: Prisma.JsonValue): CertificateSignature[] {
    return Array.isArray(value) ? (value as CertificateSignature[]) : [];
  }

  private hasText(value?: string | null): boolean {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private interpolate(template: string, values: Record<string, string>): string {
    return template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => values[key] ?? '');
  }
}
