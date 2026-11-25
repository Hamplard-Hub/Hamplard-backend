import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeeCalculatorService } from './fee-calculator.service';
import { TaxRatesController } from './tax-rates.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutQuoteService } from './checkout-quote.service';
import { CouponsModule } from '../coupons/coupons.module';
import { ReferralsModule } from '../referrals/referrals.module';

@Module({
  imports: [ConfigModule, CouponsModule, ReferralsModule],
  controllers: [TaxRatesController, CheckoutController],
  providers: [FeeCalculatorService, CheckoutQuoteService],
  exports: [FeeCalculatorService, CheckoutQuoteService],
})
export class FeeCalculatorModule {}
