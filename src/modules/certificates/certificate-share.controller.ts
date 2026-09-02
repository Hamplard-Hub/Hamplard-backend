import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CertificateShareService } from './certificate-share.service';

@ApiTags('certificates')
@Controller('certificates')
export class CertificateShareController {
  constructor(
    private readonly certificateShareService: CertificateShareService,
  ) {}

  @Post(':id/share')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a share link for an earned certificate' })
  generate(
    @Param('id') certificateId: string,
    @CurrentUser('id') studentId: string,
  ) {
    return this.certificateShareService.generateShareLink(
      certificateId,
      studentId,
    );
  }

  @Get('share/:token/metadata')
  @ApiOperation({ summary: 'Get public certificate share metadata' })
  metadata(@Param('token') token: string) {
    return this.certificateShareService.getShareMetadata(token);
  }

  @Get('share/:token')
  @ApiProduces('text/html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'View a shared certificate with Open Graph metadata' })
  async view(@Param('token') token: string) {
    const { html } = await this.certificateShareService.renderSharePage(token);
    return new StreamableFile(Buffer.from(html));
  }
}
