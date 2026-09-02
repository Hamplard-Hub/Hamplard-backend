export type CertificateOrientation = 'PORTRAIT' | 'LANDSCAPE';

export interface CertificateBranding {
  organizationName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  logoUrl?: string;
  backgroundImageUrl?: string;
  fontFamily?: string;
  footerText?: string;
}

export interface CertificateLayout {
  orientation?: CertificateOrientation;
  titleText?: string;
  subtitleText?: string;
  bodyText?: string;
  showQrCode?: boolean;
  showIssueDate?: boolean;
  showCertificateId?: boolean;
  margin?: number;
}

export interface CertificateSignature {
  name?: string;
  label?: string;
  title?: string;
  imageUrl?: string;
}

export interface CertificateTemplateConfig {
  id: string;
  name: string;
  category: string;
  branding: CertificateBranding;
  layout: CertificateLayout;
  signatures: CertificateSignature[];
  isActive: boolean;
  createdById: string;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CertificateRenderData {
  studentName: string;
  courseTitle: string;
  certificateId: string;
  issuedAt: Date;
  category?: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  missing: string[];
}

export const REQUIRED_BRANDING_FIELDS = ['organizationName', 'primaryColor'] as const;
export const REQUIRED_LAYOUT_FIELDS = ['orientation', 'titleText', 'bodyText'] as const;
export const REQUIRED_SIGNATURE_FIELDS = ['name', 'label'] as const;
export const VALID_ORIENTATIONS: CertificateOrientation[] = ['PORTRAIT', 'LANDSCAPE'];
export const HEX_COLOR_PATTERN = /^#([0-9A-Fa-f]{6})$/;
