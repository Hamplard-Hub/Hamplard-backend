import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { LiveSessionsService } from './live-sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('live-sessions')
export class LiveSessionsController {
  constructor(private readonly liveSessionsService: LiveSessionsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async scheduleSession(@Req() req: any, @Body() dto: CreateSessionDto) {
    return this.liveSessionsService.scheduleSession(req.user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateSession(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.liveSessionsService.updateSession(req.user, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async cancelSession(@Req() req: any, @Param('id') id: string) {
    return this.liveSessionsService.cancelSession(req.user, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/rsvp')
  async rsvpToSession(@Req() req: any, @Param('id') id: string) {
    return this.liveSessionsService.rsvpToSession(req.user, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/rsvp')
  async cancelRsvp(@Req() req: any, @Param('id') id: string) {
    return this.liveSessionsService.cancelRsvp(req.user, id);
  }

  @Get('upcoming')
  async getUpcomingSessions(
    @Query('courseId') courseId?: string,
    @Query('instructorAddress') instructorAddress?: string,
  ) {
    return this.liveSessionsService.getUpcomingSessions(courseId, instructorAddress);
  }

  @Get(':id')
  async getSessionById(@Param('id') id: string) {
    return this.liveSessionsService.getSessionById(id);
  }
}
