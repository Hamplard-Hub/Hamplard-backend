import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { RecommendationsService } from './recommendations.service';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

@ApiTags('course-recommendations')
@Controller('courses')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  @Get(':id/recommendations')
  @ApiOperation({ summary: 'Get related course recommendations based on co-enrollment and category' })
  @ApiParam({ name: 'id', description: 'Target course ID' })
  getRecommendations(
    @Param('id') courseId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.recommendationsService.getRecommendations(
      courseId,
      pagination.limit ?? 5,
    );
  }
}
