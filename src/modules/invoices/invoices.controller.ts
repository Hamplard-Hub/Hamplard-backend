// invoices.controller.ts
import { Controller, Get, Param, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { InvoicesService, InvoiceRequester } from './invoices.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

@ApiTags('invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get('my')
  @ApiOperation({ summary: "List the authenticated student's own invoices (paginated)" })
  findMy(@CurrentUser('id') studentId: string, @Query() query: PaginationQueryDto) {
    return this.invoicesService.findMine(studentId, query.page, query.limit);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download an invoice as a PDF (invoice owner or admin)' })
  @ApiProduces('application/pdf')
  async download(
    @CurrentUser() user: InvoiceRequester,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.invoicesService.getPdfForDownload(id, user);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
