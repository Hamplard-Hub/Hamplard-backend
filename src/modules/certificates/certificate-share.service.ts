import {
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

type ShareCertificate = {
  id: string;
  courseTitle: string;
  issuedAt: Date;
  isRevoked: boolean;
  student: { name: string | null };
  course: { thumbnailUrl: string | null };
};

@Injectable()
export class CertificateShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async generateShareLink(certificateId: string, studentId: string) {
    const certificate = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: {
        student: { select: { name: true } },
        course: { select: { thumbnailUrl: true } },
      },
    });

    if (!certificate) throw new NotFoundException('Certificate not found');
    if (certificate.studentId !== studentId) {
      throw new ForbiddenException('You can only share your own certificate');
    }
    this.assertNotRevoked(certificate);

    const share = await this.prisma.certificateShare.upsert({
      where: { certificateId },
      create: {
        certificateId,
        token: randomBytes(24).toString('base64url'),
      },
      update: {},
    });

    return this.buildShareResponse(certificate, share.token, share.viewCount);
  }

  async getShareMetadata(token: string) {
    const share = await this.findShare(token);
    this.assertNotRevoked(share.certificate);

    return this.buildShareResponse(
      share.certificate,
      share.token,
      share.viewCount,
    );
  }

  async renderSharePage(token: string) {
    const share = await this.findShare(token);
    this.assertNotRevoked(share.certificate);

    const updatedShare = await this.prisma.certificateShare.update({
      where: { id: share.id },
      data: {
        viewCount: { increment: 1 },
        lastViewedAt: new Date(),
      },
    });
    const data = this.buildShareResponse(
      share.certificate,
      share.token,
      updatedShare.viewCount,
    );

    return { ...data, html: this.buildHtml(data) };
  }

  private async findShare(token: string) {
    const share = await this.prisma.certificateShare.findUnique({
      where: { token },
      include: {
        certificate: {
          include: {
            student: { select: { name: true } },
            course: { select: { thumbnailUrl: true } },
          },
        },
      },
    });
    if (!share) throw new NotFoundException('Certificate share link not found');
    return share;
  }

  private assertNotRevoked(certificate: { isRevoked: boolean }) {
    if (certificate.isRevoked) {
      throw new GoneException('Certificate has been revoked and cannot be shared');
    }
  }

  private buildShareResponse(
    certificate: ShareCertificate,
    token: string,
    viewCount: number,
  ) {
    const shareUrl = `${this.apiBaseUrl()}/certificates/share/${encodeURIComponent(token)}`;
    const verificationUrl = `${this.frontendUrl()}/certificates/verify/${encodeURIComponent(certificate.id)}`;
    const holderName = certificate.student.name || 'A Hamplard learner';
    const title = `${holderName} earned a certificate in ${certificate.courseTitle}`;
    const description = `Verify ${holderName}'s Hamplard certificate for ${certificate.courseTitle}.`;
    const image =
      certificate.course.thumbnailUrl ||
      this.config.get<string>('CERTIFICATE_SHARE_IMAGE_URL') ||
      undefined;

    const linkedin = new URL('https://www.linkedin.com/profile/add');
    linkedin.searchParams.set('startTask', 'CERTIFICATION_NAME');
    linkedin.searchParams.set('name', certificate.courseTitle);
    linkedin.searchParams.set(
      'organizationName',
      this.config.get<string>('PLATFORM_NAME', 'Hamplard'),
    );
    linkedin.searchParams.set(
      'issueYear',
      String(certificate.issuedAt.getUTCFullYear()),
    );
    linkedin.searchParams.set(
      'issueMonth',
      String(certificate.issuedAt.getUTCMonth() + 1),
    );
    linkedin.searchParams.set('certUrl', shareUrl);
    linkedin.searchParams.set('certId', certificate.id);

    const linkedinMetadata = {
      certificationName: certificate.courseTitle,
      issuingOrganization: this.config.get<string>(
        'PLATFORM_NAME',
        'Hamplard',
      ),
      issueYear: certificate.issuedAt.getUTCFullYear(),
      issueMonth: certificate.issuedAt.getUTCMonth() + 1,
      credentialId: certificate.id,
      credentialUrl: shareUrl,
    };

    return {
      certificateId: certificate.id,
      shareUrl,
      verificationUrl,
      linkedinUrl: linkedin.toString(),
      linkedinMetadata,
      viewCount,
      openGraph: {
        title,
        description,
        type: 'website',
        url: shareUrl,
        ...(image ? { image } : {}),
      },
    };
  }

  private buildHtml(
    data: ReturnType<CertificateShareService['buildShareResponse']>,
  ) {
    const title = this.escapeHtml(data.openGraph.title);
    const description = this.escapeHtml(data.openGraph.description);
    const shareUrl = this.escapeHtml(data.shareUrl);
    const verificationUrl = this.escapeHtml(data.verificationUrl);
    const imageTag = data.openGraph.image
      ? `<meta property="og:image" content="${this.escapeHtml(data.openGraph.image)}">`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${shareUrl}">
  ${imageTag}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="${shareUrl}">
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${description}</p>
    <p><a href="${verificationUrl}">Verify this certificate</a></p>
  </main>
</body>
</html>`;
  }

  private apiBaseUrl() {
    const configured = this.config.get<string>('PUBLIC_API_URL');
    if (configured) return configured.replace(/\/$/, '');

    const appBaseUrl = this.config
      .get<string>('APP_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    const apiPrefix = this.config
      .get<string>('API_PREFIX', 'api/v1')
      .replace(/^\/+|\/+$/g, '');
    return `${appBaseUrl}/${apiPrefix}`;
  }

  private frontendUrl() {
    return this.config
      .get<string>(
        'FRONTEND_URL',
        this.config.get<string>('CORS_ORIGIN', 'http://localhost:3001'),
      )
      .replace(/\/$/, '');
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[character];
    });
  }
}
