import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutQueryDto } from './dto/payout-query.dto';
import { CreatePayoutDto, UpdatePayoutStatusDto } from './dto/create-payout.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('instructor/:instructorId')
  async getInstructorPayoutHistory(
    @CurrentUser() user: { id: string; role: UserRole },
    @Param('instructorId') instructorId: string,
    @Query() query: PayoutQueryDto,
  ) {
    return this.payoutsService.getInstructorPayoutHistory(
      user,
      instructorId,
      query,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('instructor/:instructorId/statement')
  async exportPayoutStatement(
    @CurrentUser() user: { id: string; role: UserRole },
    @Param('instructorId') instructorId: string,
    @Query() query: PayoutQueryDto,
  ) {
    return this.payoutsService.exportPayoutStatement(
      user,
      instructorId,
      query,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  async createPayout(@Body() dto: CreatePayoutDto) {
    return this.payoutsService.createPayout(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/status')
  async updatePayoutStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePayoutStatusDto,
  ) {
    return this.payoutsService.updatePayoutStatus(id, dto);
  }
}
