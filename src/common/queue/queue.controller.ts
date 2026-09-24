import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { QueueService } from './queue.service';

@ApiTags('queue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get the status of an enqueued job' })
  getJobStatus(@Param('id') jobId: string, @CurrentUser('id') userId: string) {
    return this.queueService.getJobStatus(jobId, userId);
  }
}
