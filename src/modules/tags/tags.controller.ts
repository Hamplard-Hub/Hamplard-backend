import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { MergeTagsDto } from './dto/merge-tags.dto';
import { AttachTagDto } from './dto/attach-tag.dto';
import { QueryTagsDto } from './dto/query-tags.dto';

@ApiTags('tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new tag',
    description:
      'Admin creates a searchable tag. The unique slug is auto-derived from the label. ' +
      'Returns 409 if a tag with an equivalent slug already exists.',
  })
  create(
    @CurrentUser('id') adminId: string,
    @Body() dto: CreateTagDto,
  ) {
    return this.tagsService.create(adminId, dto);
  }

  // ----------------------------------------------------------
  // LIST (public — students/instructors can browse tags)
  // ----------------------------------------------------------

  @Get()
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({
    summary: 'List all tags sorted by popularity',
    description:
      'Returns a paginated list of tags ordered by usageCount descending. ' +
      'Supports optional label search. Accessible to all authenticated users.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Filter by label (partial, case-insensitive)' })
  @ApiQuery({ name: 'page',   required: false, type: Number })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  findAll(@Query() query: QueryTagsDto) {
    return this.tagsService.findAll(query);
  }

  // ----------------------------------------------------------
  // TAGS FOR A COURSE — declared before /:id to avoid route shadowing
  // ----------------------------------------------------------

  @Get('course/:courseId')
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({
    summary: 'Get all tags attached to a course',
    description: 'Returns tags for the given course, sorted by popularity.',
  })
  @ApiParam({ name: 'courseId', description: 'Course ID' })
  findByCourse(@Param('courseId') courseId: string) {
    return this.tagsService.findByCourse(courseId);
  }

  // ----------------------------------------------------------
  // GET ONE
  // ----------------------------------------------------------

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.INSTRUCTOR, UserRole.STUDENT)
  @ApiOperation({
    summary: 'Get tag details including attached courses',
  })
  @ApiParam({ name: 'id', description: 'Tag UUID' })
  findOne(@Param('id') id: string) {
    return this.tagsService.findOne(id);
  }

  // ----------------------------------------------------------
  // UPDATE
  // ----------------------------------------------------------

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update a tag label',
    description:
      'Admin updates the display label of a tag. The slug is regenerated automatically. ' +
      'Returns 409 if the new slug collides with an existing tag.',
  })
  @ApiParam({ name: 'id', description: 'Tag UUID' })
  update(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tagsService.update(id, adminId, dto);
  }

  // ----------------------------------------------------------
  // DELETE
  // ----------------------------------------------------------

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a tag',
    description:
      'Admin permanently deletes a tag. All course associations are removed via CASCADE.',
  })
  @ApiParam({ name: 'id', description: 'Tag UUID' })
  remove(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
  ) {
    return this.tagsService.remove(id, adminId);
  }

  // ----------------------------------------------------------
  // MERGE DUPLICATES
  // ----------------------------------------------------------

  @Post(':id/merge')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge duplicate tags into a target tag',
    description:
      'Moves all course associations from the source tags into the target tag (:id), ' +
      'recalculates its usageCount, then deletes the source tags. ' +
      'Returns 400 if the target ID appears in sourceTagIds.',
  })
  @ApiParam({ name: 'id', description: 'UUID of the target (surviving) tag' })
  merge(
    @Param('id') targetTagId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: MergeTagsDto,
  ) {
    return this.tagsService.merge(targetTagId, adminId, dto);
  }

  // ----------------------------------------------------------
  // ATTACH TAG TO COURSE
  // ----------------------------------------------------------

  @Post(':id/attach')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Attach a tag to a course',
    description:
      'Links the tag to the given course and increments the tag usageCount. ' +
      'Idempotent — re-attaching the same tag to the same course is a no-op.',
  })
  @ApiParam({ name: 'id', description: 'Tag UUID' })
  attachToCourse(
    @Param('id') tagId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: AttachTagDto,
  ) {
    return this.tagsService.attachToCourse(tagId, adminId, dto);
  }

  // ----------------------------------------------------------
  // DETACH TAG FROM COURSE
  // ----------------------------------------------------------

  @Delete(':id/detach/:courseId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Detach a tag from a course',
    description:
      'Removes the link between the tag and the course, and decrements usageCount (floor 0). ' +
      'Returns 404 if the link does not exist.',
  })
  @ApiParam({ name: 'id',       description: 'Tag UUID' })
  @ApiParam({ name: 'courseId', description: 'Course ID' })
  detachFromCourse(
    @Param('id')       tagId: string,
    @Param('courseId') courseId: string,
    @CurrentUser('id') adminId: string,
  ) {
    return this.tagsService.detachFromCourse(tagId, courseId, adminId);
  }
}
