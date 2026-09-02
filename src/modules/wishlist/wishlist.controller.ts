import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { WishlistService } from './wishlist.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AddToWishlistDto } from './dto/add-to-wishlist.dto';
import { QueryWishlistDto } from './dto/query-wishlist.dto';

@ApiTags('wishlist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  /**
   * POST /api/v1/wishlist
   * Add a course to the authenticated student's wishlist.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a course to the authenticated student\'s wishlist',
    description:
      'Validates that the course exists and is ACTIVE. Prevents duplicates — ' +
      'adding a course that is already saved returns the existing item.',
  })
  add(@CurrentUser('id') studentId: string, @Body() dto: AddToWishlistDto) {
    return this.wishlistService.add(studentId, dto.courseId);
  }

  /**
   * GET /api/v1/wishlist
   * List the authenticated student's wishlist with course details.
   */
  @Get()
  @ApiOperation({
    summary: 'List the authenticated student\'s wishlist with course details',
  })
  findAll(
    @CurrentUser('id') studentId: string,
    @Query() query: QueryWishlistDto,
  ) {
    return this.wishlistService.findAll(studentId, query.page, query.limit);
  }

  /**
   * DELETE /api/v1/wishlist/:courseId
   * Remove a course from the authenticated student's wishlist.
   */
  @Delete(':courseId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a course from the authenticated student\'s wishlist',
  })
  @ApiParam({ name: 'courseId', description: 'Course ID to remove from the wishlist' })
  remove(
    @CurrentUser('id') studentId: string,
    @Param('courseId') courseId: string,
  ) {
    return this.wishlistService.remove(studentId, courseId);
  }
}
