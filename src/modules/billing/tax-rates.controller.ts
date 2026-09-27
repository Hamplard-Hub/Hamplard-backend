// tax-rates.controller.ts
import {
  Controller, Get, Put, Delete, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { FeeCalculatorService } from './fee-calculator.service';
import { UpsertTaxRateDto } from './dto/upsert-tax-rate.dto';

@ApiTags('admin/tax-rates')
@Controller('admin/tax-rates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class TaxRatesController {
  constructor(private readonly feeCalculator: FeeCalculatorService) {}

  @Get()
  @ApiOperation({ summary: 'List all configured regional tax rates (admin)' })
  findAll() {
    return this.feeCalculator.listTaxRates();
  }

  @Put(':region')
  @ApiOperation({ summary: 'Create or update the tax rate for a region (admin)' })
  @ApiParam({ name: 'region', description: 'ISO country code, "EU", or "DEFAULT"', example: 'NG' })
  upsert(@Param('region') region: string, @Body() dto: UpsertTaxRateDto) {
    return this.feeCalculator.upsertTaxRate(region, dto);
  }

  @Delete(':region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a regional tax rate — the region falls back to DEFAULT (admin)' })
  @ApiParam({ name: 'region', example: 'NG' })
  remove(@Param('region') region: string) {
    return this.feeCalculator.removeTaxRate(region);
  }
}
