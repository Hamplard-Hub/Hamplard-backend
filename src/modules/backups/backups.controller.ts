import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles, RolesGuard } from "../../common/guards/roles.guard";
import { BackupsService, UserContext } from "./backups.service";
import { QueryCourseBackupsDto } from "./dto/course-backup.dto";

@ApiTags("backups")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.INSTRUCTOR, UserRole.ADMIN)
@Controller("backups/courses")
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  @Post(":courseId/export")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Export a full course structure and content as a restorable backup file",
  })
  exportCourse(
    @Param("courseId") courseId: string,
    @CurrentUser() user: UserContext,
  ) {
    return this.backupsService.exportCourseBackup(courseId, user, false);
  }

  @Get(":courseId/versions")
  @ApiOperation({ summary: "Track backup file versions for a course" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getCourseBackupVersions(
    @Param("courseId") courseId: string,
    @CurrentUser() user: UserContext,
    @Query("page") page?: number,
    @Query("limit") limit?: number,
  ) {
    return this.backupsService.getCourseBackupVersions(
      courseId,
      user,
      page ? Number(page) : 1,
      limit ? Number(limit) : 20,
    );
  }

  @Get(":courseId/versions/:version")
  @ApiOperation({ summary: "Get a specific backup version for a course" })
  getCourseBackupByVersion(
    @Param("courseId") courseId: string,
    @Param("version", ParseIntPipe) version: number,
    @CurrentUser() user: UserContext,
  ) {
    return this.backupsService.getCourseBackupByVersion(
      courseId,
      version,
      user,
    );
  }

  @Get("export/:backupId/status")
  @ApiOperation({ summary: "Provide backup download status and metadata" })
  getBackupStatus(
    @Param("backupId") backupId: string,
    @CurrentUser() user: UserContext,
  ) {
    return this.backupsService.getBackupStatus(backupId, user);
  }

  @Get("export/:backupId/download")
  @ApiOperation({ summary: "Download the restorable course backup payload" })
  downloadBackup(
    @Param("backupId") backupId: string,
    @CurrentUser() user: UserContext,
  ) {
    return this.backupsService.downloadBackup(backupId, user);
  }

  @Get("export/list")
  @ApiOperation({ summary: "List and filter course backups" })
  listBackups(
    @Query() query: QueryCourseBackupsDto,
    @CurrentUser() user: UserContext,
  ) {
    return this.backupsService.listBackups(query, user);
  }

  @Post("scheduled/run")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Manually trigger scheduled automatic course backups (Admin only)",
  })
  runScheduledBackups() {
    return this.backupsService.runScheduledBackups();
  }
}
