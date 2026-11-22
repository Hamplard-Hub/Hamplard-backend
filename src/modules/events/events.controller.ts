import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { EventsService } from './events.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { QueryEventsDto } from './dto/query-events.dto';

@ApiTags('events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List on-chain events with optional course filter' })
  findAll(@Query() query: QueryEventsDto) {
    return this.eventsService.findAll(query.courseId, query.page, query.limit);
  }

  @Get('dead-lettered')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List chain events that exhausted automatic retries' })
  findDeadLetterEvents(@Query() query: QueryEventsDto) {
    return this.eventsService.findDeadLetterEvents(query.page, query.limit);
  }

  @Post(':id/retry')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Retry a dead-lettered chain event' })
  retryDeadLetterEvent(@Param('id') id: string) {
    return this.eventsService.retryDeadLetterEvent(id);
  }
}
