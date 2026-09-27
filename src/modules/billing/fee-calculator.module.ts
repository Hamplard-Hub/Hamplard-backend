// fee-calculator.module.ts
import { Module } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { TaxRatesController } from './tax-rates.controller';

@Module({
  controllers: [TaxRatesController],
  providers: [FeeCalculatorService],
  exports: [FeeCalculatorService],
})
export class FeeCalculatorModule {}
