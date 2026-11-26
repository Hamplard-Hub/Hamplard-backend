import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProduces } from '@nestjs/swagger';
import { Response } from 'express';
import { CertificatesService, CertificateRequester } from './certificates.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
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
  @ApiOperation({ summary: 'Get public certificate details by ID (public, no admin PII)' })
  findOne(@Param('id') id: string) {
    return this.certificatesService.findPublicById(id);
  }

  /** Protected routes below */

  @Get('my/all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all certificates for the authenticated student (paginated)' })
  findMy(
    @CurrentUser('id') studentId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.certificatesService.findByStudent(studentId, pagination.page, pagination.limit);
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

  @Get(':id/admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Admin] Get full certificate details including revocation audit info' })
  findOneForAdmin(@Param('id') id: string) {
    return this.certificatesService.findById(id);
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
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download the PDF certificate (holder or admin only)' })
  async download(
    @Param('id') id: string,
    @CurrentUser() user: CertificateRequester,
    @Res() res: Response,
  ) {
    // Throws 403/404 before any headers are written (issue #245).
    const { buffer, filename } = await this.certificatesService.getPdfForDownload(id, user);

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buffer.length),
      'Cache-Control':       'private, no-store',
    });
    res.end(buffer);
  }
}