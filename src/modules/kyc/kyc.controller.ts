import {
  Controller, Get, Post, Body, Param, Query,
  UseGuards, UseInterceptors, UploadedFile, UploadedFiles,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { KycStatus, UserRole } from '@prisma/client';
import { QueryKycDto } from './dto/query-kyc.dto';

@ApiTags('kyc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  // ----------------------------------------------------------
  // INSTRUCTOR — SUBMIT & VIEW OWN KYC
  // ----------------------------------------------------------

  @Post('submit')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'document', maxCount: 1 },
        { name: 'additional', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'KYC document submission. Upload "document" (required) and optionally "additional" (e.g. selfie).',
    schema: {
      type: 'object',
      required: ['documentType', 'document'],
      properties: {
        documentType: { type: 'string', enum: ['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'UTILITY_BILL', 'BANK_STATEMENT', 'OTHER'] },
        notes: { type: 'string' },
        document: { type: 'string', format: 'binary' },
        additional: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Submit KYC identity documents for verification (instructor only)' })
  submit(
    @CurrentUser('id') instructorId: string,
    @Body() dto: SubmitKycDto,
    @UploadedFiles() files: { document?: Express.Multer.File[]; additional?: Express.Multer.File[] },
  ) {
    const documentFile = files?.document?.[0];
    const additionalFile = files?.additional?.[0];
    return this.kycService.submit(instructorId, dto, documentFile, additionalFile);
  }

  @Get('my')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'Get your own KYC submission history and current status' })
  findMy(@CurrentUser('id') instructorId: string) {
    return this.kycService.findMySubmissions(instructorId);
  }

  @Get('my/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'Get your current KYC verification status (used by payouts)' })
  getMyStatus(@CurrentUser('id') instructorId: string) {
    return this.kycService.getVerificationStatus(instructorId);
  }

  // ----------------------------------------------------------
  // ADMIN — VIEW & REVIEW ALL SUBMISSIONS
  // ----------------------------------------------------------

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all KYC submissions (admin only)' })
  findAll(@Query() query: QueryKycDto) {
    return this.kycService.findAll(query.page, query.limit, query.status);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get a single KYC submission detail (admin only)' })
  findOne(@Param('id') id: string) {
    return this.kycService.findOne(id);
  }

  @Post(':id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a KYC submission (admin only)' })
  review(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ReviewKycDto,
  ) {
    return this.kycService.review(id, adminId, dto);
  }
}
