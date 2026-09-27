// fee-calculator.service.ts
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface FeeBreakdown {
  currency: string;
  basePrice: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  instructorPayout: number;
  region: string;
  taxRatePercent: number;
  taxAmount: number;
  totalPayable: number;
}

/** How long tax rates are cached in memory before re-reading from the DB. */
const TAX_RATE_CACHE_TTL_MS = 60_000;
const DEFAULT_REGION = 'DEFAULT';

@Injectable()
export class FeeCalculatorService {
  private readonly logger = new Logger(FeeCalculatorService.name);

  private taxRateCache: { rates: Map<string, number>; loadedAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // TAX RATES — admin-configurable, stored in `tax_rates`
  // ----------------------------------------------------------

  private normalizeRegion(region?: string): string {
    return (region?.trim() || DEFAULT_REGION).toUpperCase();
  }

  private async loadTaxRates(): Promise<Map<string, number>> {
    if (this.taxRateCache && Date.now() - this.taxRateCache.loadedAt < TAX_RATE_CACHE_TTL_MS) {
      return this.taxRateCache.rates;
    }
    const rows = await this.prisma.taxRate.findMany({ where: { isActive: true } });
    const rates = new Map(rows.map((r) => [r.region, Number(r.ratePercent)]));
    this.taxRateCache = { rates, loadedAt: Date.now() };
    return rates;
  }

  private invalidateTaxRateCache() {
    this.taxRateCache = null;
  }

  /**
   * Looks up the tax rate for a region, falling back to the DEFAULT rate
   * (with a warning) if the region has no active configured rate rather than
   * failing checkout outright. If no DEFAULT is configured either, 0 is used.
   */
  async getTaxRate(region?: string): Promise<number> {
    const key = this.normalizeRegion(region);
    const rates = await this.loadTaxRates();
    const rate = rates.get(key);
    if (rate !== undefined) return rate;

    if (key !== DEFAULT_REGION) {
      this.logger.warn(`No tax rate configured for region "${region}", falling back to default`);
    }
    return rates.get(DEFAULT_REGION) ?? 0;
  }

  listTaxRates() {
    return this.prisma.taxRate.findMany({ orderBy: { region: 'asc' } });
  }

  async upsertTaxRate(
    region: string,
    dto: { ratePercent: number; description?: string; isActive?: boolean },
  ) {
    const key = this.normalizeRegion(region);
    const taxRate = await this.prisma.taxRate.upsert({
      where: { region: key },
      create: {
        region: key,
        ratePercent: dto.ratePercent,
        description: dto.description,
        isActive: dto.isActive ?? true,
      },
      update: {
        ratePercent: dto.ratePercent,
        description: dto.description,
        isActive: dto.isActive,
      },
    });
    this.invalidateTaxRateCache();
    this.logger.log(`Tax rate for ${key} set to ${dto.ratePercent}%`);
    return taxRate;
  }

  async removeTaxRate(region: string) {
    const key = this.normalizeRegion(region);
    const existing = await this.prisma.taxRate.findUnique({ where: { region: key } });
    if (!existing) throw new NotFoundException(`No tax rate configured for region "${key}"`);

    await this.prisma.taxRate.delete({ where: { region: key } });
    this.invalidateTaxRateCache();
    this.logger.log(`Tax rate for ${key} removed`);
    return { region: key, deleted: true };
  }

  /** Rounds to 2 decimal places, the smallest unit tracked for USDC amounts. */
  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  async computeBreakdown(params: {
    coursePrice: number;
    platformFeePercent: number;
    region?: string;
  }): Promise<FeeBreakdown> {
    const { coursePrice, platformFeePercent, region } = params;

    if (coursePrice < 0) {
      throw new BadRequestException('Course price cannot be negative');
    }
    if (platformFeePercent < 0 || platformFeePercent > 100) {
      throw new BadRequestException('Platform fee percent must be between 0 and 100');
    }

    const taxRatePercent = await this.getTaxRate(region);
    const platformFeeAmount = this.round(coursePrice * (platformFeePercent / 100));
    const instructorPayout = this.round(coursePrice - platformFeeAmount);
    const taxAmount = this.round(coursePrice * (taxRatePercent / 100));
    const totalPayable = this.round(coursePrice + taxAmount);

    return {
      currency: 'USDC',
      basePrice: this.round(coursePrice),
      platformFeePercent,
      platformFeeAmount,
      instructorPayout,
      region: this.normalizeRegion(region),
      taxRatePercent,
      taxAmount,
      totalPayable,
    };
  }
}
