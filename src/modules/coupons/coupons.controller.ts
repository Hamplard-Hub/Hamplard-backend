import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, HttpCode, HttpStatus, Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CouponsService, CouponActor } from './coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ValidateCouponDto } from './dto/validate-coupon.dto';
import { QueryCouponsDto } from './dto/query-coupons.dto';
import { RedeemCouponDto } from './dto/redeem-coupon.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { UserRole } from '@prisma/client';

@ApiTags('coupons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  // ----------------------------------------------------------
  // ADMIN / INSTRUCTOR — CREATE & MANAGE
  // ----------------------------------------------------------

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new discount coupon (admin or instructor)',
    description: 'Instructors must scope the coupon to a course they own; only admins can create platform-wide coupons.',
  })
  create(
    @CurrentUser() user: CouponActor,
    @Body() dto: CreateCouponDto,
  ) {
    return this.couponsService.create(user, dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'List coupons (admins see all, instructors see their own)' })
  findAll(
    @CurrentUser() user: CouponActor,
    @Query() query: QueryCouponsDto,
  ) {
    return this.couponsService.findAll(user, query.page, query.limit, query.isActive);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'Get a coupon by ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: CouponActor) {
    return this.couponsService.findOne(id, user);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'Update coupon settings (discount value, expiry, limits)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCouponDto,
    @CurrentUser() user: CouponActor,
  ) {
    return this.couponsService.update(id, dto, user);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a coupon (soft delete)' })
  deactivate(@Param('id') id: string, @CurrentUser() user: CouponActor) {
    return this.couponsService.deactivate(id, user);
  }

  @Get(':id/redemptions')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR)
  @ApiOperation({ summary: 'List all redemptions for a coupon' })
  getRedemptions(
    @Param('id') id: string,
    @CurrentUser() user: CouponActor,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.couponsService.getRedemptions(id, user, pagination.page, pagination.limit);
  }

  // ----------------------------------------------------------
  // ALL AUTHENTICATED USERS — CHECKOUT VALIDATION
  // ----------------------------------------------------------

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a coupon code at checkout and get discounted price' })
  validate(
    @CurrentUser('id') userId: string,
    @Body() dto: ValidateCouponDto,
  ) {
    return this.couponsService.validate(userId, dto);
  }

  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a coupon redemption against a verified enrollment' })
  redeem(
    @CurrentUser('id') userId: string,
    @Body() dto: RedeemCouponDto,
  ) {
    return this.couponsService.redeem(userId, dto);
  }
}
