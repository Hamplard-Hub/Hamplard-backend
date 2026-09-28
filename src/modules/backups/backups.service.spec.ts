import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import {
  CourseBackupStatus,
  CourseStatus,
  LessonType,
  UserRole,
} from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { BackupsService } from "./backups.service";

describe("BackupsService", () => {
  let service: BackupsService;

  const mockPrisma = {
    course: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    courseBackup: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  };

  const sampleCourse = {
    id: "course-123",
    title: "Sewing Basics",
    description: "Learn foundational sewing techniques",
    category: "Tailoring",
    level: "Beginner",
    language: "English",
    thumbnailUrl: "https://example.com/thumb.jpg",
    previewVideoUrl: "https://example.com/preview.mp4",
    price: 49.99,
    platformFeePercent: 20,
    status: CourseStatus.ACTIVE,
    instructorAddress: "GBB4NR2",
    modules: [
      {
        id: "mod-1",
        title: "Introduction",
        position: 0,
        lessons: [
          {
            id: "les-1",
            title: "Welcome",
            description: "Course introduction",
            type: LessonType.VIDEO,
            videoUrl: "https://example.com/video1.mp4",
            videoDuration: 300,
            content: null,
            resourceUrl: null,
            position: 0,
            isFree: true,
          },
          {
            id: "les-2",
            title: "Tool guide",
            description: "Required sewing kit",
            type: LessonType.TEXT,
            videoUrl: null,
            videoDuration: null,
            content: "Here is what you need...",
            resourceUrl: "https://example.com/sheet.pdf",
            position: 1,
            isFree: false,
          },
        ],
      },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BackupsService>(BackupsService);
    jest.clearAllMocks();
  });

  describe("exportCourseBackup", () => {
    it("should export full course structure and create version 1 when no previous backup exists", async () => {
      mockPrisma.course.findUnique.mockResolvedValue(sampleCourse);
      mockPrisma.courseBackup.findFirst.mockResolvedValue(null);
      mockPrisma.courseBackup.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: "backup-1", ...data }),
      );

      const user = {
        id: "u-1",
        role: UserRole.INSTRUCTOR,
        stellarAddress: "GBB4NR2",
      };

      const result = await service.exportCourseBackup("course-123", user);

      expect(mockPrisma.course.findUnique).toHaveBeenCalledWith({
        where: { id: "course-123" },
        include: {
          modules: {
            orderBy: { position: "asc" },
            include: {
              lessons: {
                orderBy: { position: "asc" },
              },
            },
          },
        },
      });

      expect(mockPrisma.courseBackup.findFirst).toHaveBeenCalledWith({
        where: { courseId: "course-123" },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      expect(mockPrisma.courseBackup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          courseId: "course-123",
          version: 1,
          status: CourseBackupStatus.COMPLETED,
          isAutomatic: false,
          requestedBy: "u-1",
          isComplete: true,
        }),
      });

      expect(result.version).toBe(1);
      expect(result.status).toBe(CourseBackupStatus.COMPLETED);
    });

    it("should increment version when a previous backup exists for the course", async () => {
      mockPrisma.course.findUnique.mockResolvedValue(sampleCourse);
      mockPrisma.courseBackup.findFirst.mockResolvedValue({ version: 3 });
      mockPrisma.courseBackup.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: "backup-4", ...data }),
      );

      const adminUser = { id: "admin-1", role: UserRole.ADMIN };
      const result = await service.exportCourseBackup("course-123", adminUser);

      expect(result.version).toBe(4);
      expect(mockPrisma.courseBackup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          version: 4,
          requestedBy: "admin-1",
        }),
      });
    });

    it("should throw NotFoundException if course does not exist", async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(
        service.exportCourseBackup("non-existent", {
          id: "u-1",
          role: UserRole.ADMIN,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ForbiddenException if instructor does not own the course", async () => {
      mockPrisma.course.findUnique.mockResolvedValue(sampleCourse);

      const unauthorizedInstructor = {
        id: "u-2",
        role: UserRole.INSTRUCTOR,
        stellarAddress: "GDIFFERENTADDRESS",
      };

      await expect(
        service.exportCourseBackup("course-123", unauthorizedInstructor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("validateCompleteness", () => {
    it("should mark complete when course, modules, and lessons are valid", () => {
      const report = service.validateCompleteness(sampleCourse);

      expect(report.isComplete).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.totalModules).toBe(1);
      expect(report.totalLessons).toBe(2);
      expect(report.totalVideoLessons).toBe(1);
      expect(report.totalTextLessons).toBe(1);
      expect(report.missingVideoLessons).toHaveLength(0);
      expect(report.missingContentLessons).toHaveLength(0);
    });

    it("should flag errors when video lesson lacks videoUrl or text lesson lacks content", () => {
      const incompleteCourse = {
        ...sampleCourse,
        modules: [
          {
            id: "mod-1",
            title: "Basics",
            position: 0,
            lessons: [
              {
                id: "l-v",
                title: "Missing Video",
                position: 0,
                type: LessonType.VIDEO,
                videoUrl: "",
              },
              {
                id: "l-t",
                title: "Missing Text",
                position: 1,
                type: LessonType.TEXT,
                content: "",
              },
            ],
          },
        ],
      };

      const report = service.validateCompleteness(incompleteCourse);

      expect(report.isComplete).toBe(false);
      expect(report.missingVideoLessons).toHaveLength(1);
      expect(report.missingContentLessons).toHaveLength(1);
      expect(report.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("has no video URL"),
          expect.stringContaining("has no textual content"),
        ]),
      );
    });

    it("should flag error if course has zero modules", () => {
      const noModuleCourse = {
        ...sampleCourse,
        modules: [],
      };

      const report = service.validateCompleteness(noModuleCourse);
      expect(report.isComplete).toBe(false);
      expect(report.errors).toContain("Course contains no modules");
    });

    it("should add warnings for duplicate positions or empty modules", () => {
      const duplicatePosCourse = {
        ...sampleCourse,
        modules: [
          {
            id: "m1",
            title: "Module 1",
            position: 0,
            lessons: [],
          },
          {
            id: "m2",
            title: "Module 2",
            position: 0,
            lessons: [
              {
                id: "l1",
                title: "L1",
                position: 0,
                type: LessonType.VIDEO,
                videoUrl: "http://video",
              },
              {
                id: "l2",
                title: "L2",
                position: 0,
                type: LessonType.TEXT,
                content: "content",
              },
            ],
          },
        ],
      };

      const report = service.validateCompleteness(duplicatePosCourse);
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("contains no lessons"),
          expect.stringContaining("Duplicate module position"),
          expect.stringContaining("Duplicate lesson position"),
        ]),
      );
    });
  });

  describe("getCourseBackupVersions", () => {
    it("should return paginated list of versions for course", async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: "course-123",
        instructorAddress: "GBB4NR2",
      });
      mockPrisma.courseBackup.findMany.mockResolvedValue([
        { id: "b2", version: 2, courseId: "course-123" },
        { id: "b1", version: 1, courseId: "course-123" },
      ]);
      mockPrisma.courseBackup.count.mockResolvedValue(2);

      const result = await service.getCourseBackupVersions("course-123", {
        id: "u-1",
        role: UserRole.ADMIN,
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
    });
  });

  describe("getCourseBackupByVersion", () => {
    it("should return specific backup version", async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: "course-123",
        instructorAddress: "GBB4NR2",
      });
      mockPrisma.courseBackup.findUnique.mockResolvedValue({
        id: "b-v2",
        courseId: "course-123",
        version: 2,
      });

      const result = await service.getCourseBackupByVersion("course-123", 2);
      expect(result.version).toBe(2);
    });

    it("should throw NotFoundException if version not found", async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: "course-123",
        instructorAddress: "GBB4NR2",
      });
      mockPrisma.courseBackup.findUnique.mockResolvedValue(null);

      await expect(
        service.getCourseBackupByVersion("course-123", 99),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getBackupStatus", () => {
    it("should return status and metadata for a backup", async () => {
      mockPrisma.courseBackup.findUnique.mockResolvedValue({
        id: "b-1",
        courseId: "course-123",
        version: 1,
        status: CourseBackupStatus.COMPLETED,
        isAutomatic: false,
        isComplete: true,
        fileSizeBytes: 1200,
        checksum: "sha-123",
        downloadCount: 0,
        lastDownloadedAt: null,
        errorMessage: null,
        validationReport: { isComplete: true },
        createdAt: new Date(),
        updatedAt: new Date(),
        course: {
          id: "course-123",
          title: "Sewing",
          instructorAddress: "GBB4NR2",
        },
        requester: { id: "u-1", name: "Alice", email: "alice@example.com" },
      });

      const status = await service.getBackupStatus("b-1");
      expect(status.id).toBe("b-1");
      expect(status.status).toBe(CourseBackupStatus.COMPLETED);
      expect(status.version).toBe(1);
      expect(status.checksum).toBe("sha-123");
    });

    it("should throw NotFoundException if backup does not exist", async () => {
      mockPrisma.courseBackup.findUnique.mockResolvedValue(null);
      await expect(service.getBackupStatus("unknown")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("downloadBackup", () => {
    it("should return payload and increment downloadCount for completed backup", async () => {
      mockPrisma.courseBackup.findUnique.mockResolvedValue({
        id: "b-1",
        courseId: "course-123",
        version: 1,
        status: CourseBackupStatus.COMPLETED,
        payload: { courseId: "course-123", version: 1 },
        checksum: "hash-abc",
        fileSizeBytes: 500,
        course: { id: "course-123", instructorAddress: "GBB4NR2" },
      });
      mockPrisma.courseBackup.update.mockResolvedValue({});

      const result = await service.downloadBackup("b-1");

      expect(result.filename).toBe("course-course-123-v1.json");
      expect(result.checksum).toBe("hash-abc");
      expect(mockPrisma.courseBackup.update).toHaveBeenCalledWith({
        where: { id: "b-1" },
        data: {
          downloadCount: { increment: 1 },
          lastDownloadedAt: expect.any(Date),
        },
      });
    });

    it("should throw BadRequestException if backup is not completed", async () => {
      mockPrisma.courseBackup.findUnique.mockResolvedValue({
        id: "b-pending",
        courseId: "course-123",
        version: 1,
        status: CourseBackupStatus.PENDING,
        course: { id: "course-123", instructorAddress: "GBB4NR2" },
      });

      await expect(service.downloadBackup("b-pending")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("scheduled automatic backups", () => {
    it("should execute scheduled automatic backups for all active courses", async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: "course-1" },
        { id: "course-2" },
      ]);

      // Mock exportCourseBackup call
      jest
        .spyOn(service, "exportCourseBackup")
        .mockResolvedValueOnce({ id: "b-1" } as any)
        .mockResolvedValueOnce({ id: "b-2" } as any);

      const summary = await service.handleScheduledAutomaticBackups();

      expect(summary.totalEligibleCourses).toBe(2);
      expect(summary.successfulBackups).toBe(2);
      expect(summary.failedBackups).toBe(0);
      expect(service.exportCourseBackup).toHaveBeenCalledTimes(2);
      expect(service.exportCourseBackup).toHaveBeenCalledWith(
        "course-1",
        undefined,
        true,
      );
    });

    it("should track errors gracefully when an automatic backup fails", async () => {
      mockPrisma.course.findMany.mockResolvedValue([{ id: "fail-course" }]);

      jest
        .spyOn(service, "exportCourseBackup")
        .mockRejectedValueOnce(new Error("Database lock"));

      const summary = await service.runScheduledBackups();

      expect(summary.totalEligibleCourses).toBe(1);
      expect(summary.successfulBackups).toBe(0);
      expect(summary.failedBackups).toBe(1);
      expect(summary.errors[0]).toEqual({
        courseId: "fail-course",
        message: "Database lock",
      });
    });
  });
});
