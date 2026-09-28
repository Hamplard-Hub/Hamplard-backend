import {
  Controller, Get, Post, Patch, Body, Param, UseGuards, HttpCode, HttpStatus,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CertificatesService } from './certificates.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

import {
  IssueCertificateDto,
  UpdateCertificateTxHashDto,
  RevokeCertificateDto,
} from './dto/issue-certificate.dto';

@ApiTags('certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  /** Public — no auth needed. Anyone can verify a certificate by ID. */
  @Get('verify/:id')
  @ApiOperation({ summary: 'Verify a certificate by ID (public, no auth required)' })
  verify(@Param('id') id: string) {
    return this.certificatesService.verify(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get full certificate details by ID (public)' })
  findOne(@Param('id') id: string) {
    return this.certificatesService.findById(id);
  }

  /** Protected routes below */

  @Get('my/all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all certificates for the authenticated student' })
  findMy(@CurrentUser('id') studentId: string) {
    return this.certificatesService.findByStudent(studentId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin issues a certificate for a completed student' })
  issue(
    @CurrentUser('id') adminId: string,
    @Body() dto: IssueCertificateDto,
  ) {
    return this.certificatesService.issue(adminId, dto.studentId, dto.courseId);
  }

  @Patch(':id/tx-hash')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update on-chain tx hash after issue_certificate() is called' })
  updateTxHash(@Param('id') id: string, @Body() dto: UpdateCertificateTxHashDto) {
    return this.certificatesService.updateTxHash(id, dto.txHash);
  }

  @Post(':id/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin revokes a certificate' })
  revoke(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto?: RevokeCertificateDto,
  ) {
    return this.certificatesService.revoke(id, adminId, dto?.reason);
  }

  @Get(':id/download')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download the PDF certificate by ID' })
  async download(@Param('id') id: string, @Res() res: any) {
    const certificate = await this.certificatesService.findById(id);

    if (!certificate.pdfUrl) {
      throw new NotFoundException('PDF certificate not found for this ID');
    }

    res.json({
      pdfUrl: certificate.pdfUrl,
      message: 'PDF certificate ready for download',
    });
  }
}