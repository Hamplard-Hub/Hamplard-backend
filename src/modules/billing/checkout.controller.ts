import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CheckoutQuoteService } from './checkout-quote.service';
import { CreateCheckoutQuoteDto } from './dto/create-checkout-quote.dto';

@ApiTags('checkout')
@Controller('checkout')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CheckoutController {
  constructor(private readonly checkoutQuotes: CheckoutQuoteService) {}

  @Post('quote')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Get a signed, short-lived checkout quote (price, discounts, tax, total)',
    description:
      'Prices are computed server-side. Pay exactly `total` on-chain, then pass ' +
      '`quoteId` to POST /enrollments — the coupon and referral reward are redeemed with the enrollment.',
  })
  createQuote(
    @CurrentUser('id') studentId: string,
    @Body() dto: CreateCheckoutQuoteDto,
  ) {
    return this.checkoutQuotes.createQuote(studentId, dto);
  }
}
