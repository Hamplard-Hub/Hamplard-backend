import { Test, TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";

describe("BackupsController", () => {
  let controller: BackupsController;

  const mockBackupsService = {
    exportCourseBackup: jest.fn(),
    getCourseBackupVersions: jest.fn(),
    getCourseBackupByVersion: jest.fn(),
    getBackupStatus: jest.fn(),
    downloadBackup: jest.fn(),
    listBackups: jest.fn(),
    runScheduledBackups: jest.fn(),
  };

  const mockUser = {
    id: "user-1",
    role: UserRole.INSTRUCTOR,
    stellarAddress: "GADDR",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BackupsController],
      providers: [
        {
          provide: BackupsService,
          useValue: mockBackupsService,
        },
      ],
    }).compile();

    controller = module.get<BackupsController>(BackupsController);
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("exportCourse", () => {
    it("should trigger course backup export", async () => {
      mockBackupsService.exportCourseBackup.mockResolvedValue({
        id: "backup-1",
        version: 1,
      });

      const res = await controller.exportCourse("course-1", mockUser);

      expect(mockBackupsService.exportCourseBackup).toHaveBeenCalledWith(
        "course-1",
        mockUser,
        false,
      );
      expect(res).toEqual({ id: "backup-1", version: 1 });
    });
  });

  describe("getCourseBackupVersions", () => {
    it("should retrieve versions for course with pagination", async () => {
      mockBackupsService.getCourseBackupVersions.mockResolvedValue({
        data: [{ version: 2 }, { version: 1 }],
        meta: { total: 2, page: 1, limit: 10 },
      });

      const res = await controller.getCourseBackupVersions(
        "course-1",
        mockUser,
        1,
        10,
      );

      expect(mockBackupsService.getCourseBackupVersions).toHaveBeenCalledWith(
        "course-1",
        mockUser,
        1,
        10,
      );
      expect(res.data).toHaveLength(2);
    });
  });

  describe("getCourseBackupByVersion", () => {
    it("should retrieve a specific version", async () => {
      mockBackupsService.getCourseBackupByVersion.mockResolvedValue({
        id: "b-2",
        version: 2,
      });

      const res = await controller.getCourseBackupByVersion(
        "course-1",
        2,
        mockUser,
      );

      expect(mockBackupsService.getCourseBackupByVersion).toHaveBeenCalledWith(
        "course-1",
        2,
        mockUser,
      );
      expect(res.version).toBe(2);
    });
  });

  describe("getBackupStatus", () => {
    it("should retrieve download status and metadata", async () => {
      mockBackupsService.getBackupStatus.mockResolvedValue({
        id: "backup-1",
        status: "COMPLETED",
      });

      const res = await controller.getBackupStatus("backup-1", mockUser);

      expect(mockBackupsService.getBackupStatus).toHaveBeenCalledWith(
        "backup-1",
        mockUser,
      );
      expect(res.status).toBe("COMPLETED");
    });
  });

  describe("downloadBackup", () => {
    it("should download backup file payload", async () => {
      mockBackupsService.downloadBackup.mockResolvedValue({
        filename: "course-course-1-v1.json",
        payload: { courseId: "course-1" },
      });

      const res = await controller.downloadBackup("backup-1", mockUser);

      expect(mockBackupsService.downloadBackup).toHaveBeenCalledWith(
        "backup-1",
        mockUser,
      );
      expect(res.filename).toBe("course-course-1-v1.json");
    });
  });

  describe("listBackups", () => {
    it("should list backups with filters", async () => {
      mockBackupsService.listBackups.mockResolvedValue({
        data: [],
        meta: { total: 0 },
      });

      const res = await controller.listBackups({}, mockUser);

      expect(mockBackupsService.listBackups).toHaveBeenCalledWith({}, mockUser);
      expect(res.meta.total).toBe(0);
    });
  });

  describe("runScheduledBackups", () => {
    it("should manually run scheduled backups", async () => {
      mockBackupsService.runScheduledBackups.mockResolvedValue({
        successfulBackups: 5,
      });

      const res = await controller.runScheduledBackups();

      expect(mockBackupsService.runScheduledBackups).toHaveBeenCalled();
      expect(res.successfulBackups).toBe(5);
    });
  });
});
