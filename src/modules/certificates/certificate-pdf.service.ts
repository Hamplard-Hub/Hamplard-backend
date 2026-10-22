import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { CertificateTemplatesService } from './certificate-templates.service';
import {
  CertificateRenderData,
  CertificateTemplateConfig,
} from './certificate-template.types';

const REQUIRED_RENDER_FIELDS = ['studentName', 'courseTitle', 'certificateId', 'issuedAt'];

@Injectable()
export class CertificatePdfService {
  private readonly logger = new Logger(CertificatePdfService.name);

  constructor(private readonly templates: CertificateTemplatesService) {}

  async getActiveTemplate(category: string): Promise<CertificateTemplateConfig> {
    return this.templates.getActiveTemplateForCategory(category);
  }

  async renderForCategory(category: string, data: CertificateRenderData): Promise<Buffer> {
    this.validateRenderData(data);

    const template = await this.templates.getActiveTemplateForCategory(category);
    this.logger.debug(`Rendering certificate PDF with template ${template.id} for category "${category}"`);
    return this.templates.renderPdf(template, {
      ...data,
      category: data.category ?? category,
    });
  }

  private validateRenderData(data: CertificateRenderData): void {
    const missing: string[] = [];
    for (const field of REQUIRED_RENDER_FIELDS) {
      const value = data[field as keyof CertificateRenderData];
      if (!value || (typeof value === 'string' && !value.trim())) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Certificate render data is missing required fields: ${missing.join(', ')}`,
      );
    }
  }
}
