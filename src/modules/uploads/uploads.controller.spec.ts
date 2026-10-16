import { Test, TestingModule } from '@nestjs/testing';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { VideoTranscodeService } from './video-transcode.service';
import { VirusScanService } from './virus-scan.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('UploadsController', () => {
  let controller: UploadsController;

  const mockUploadsService = {
    validateFile: jest.fn(),
    saveFile: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/asset.png' }),
    saveVideo: jest.fn().mockResolvedValue({ jobId: 'job-123', originUrl: '/uploads/video.mp4' }),
  };

  const mockVideoTranscodeService = {
    getJobStatus: jest.fn(),
  };

  const mockVirusScanService = {
    getScanStatus: jest.fn(),
  };

  const mockPrisma = {
    course: {
      findUnique: jest.fn(),
    },
    lesson: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        { provide: UploadsService, useValue: mockUploadsService },
        { provide: VideoTranscodeService, useValue: mockVideoTranscodeService },
        { provide: VirusScanService, useValue: mockVirusScanService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<UploadsController>(UploadsController);
    jest.clearAllMocks();
  });

  describe('uploadCourseAsset', () => {
    const fakeFile = {
      originalname: 'thumbnail.png',
      mimetype: 'image/png',
      size: 500,
      buffer: Buffer.from('abc'),
    } as Express.Multer.File;

    it('rejects if no file provided', async () => {
      await expect(
        controller.uploadCourseAsset({ user: { id: 'inst-1' } }, null as any, 'course-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects with 404 if course not found', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(
        controller.uploadCourseAsset({ user: { id: 'inst-1' } }, fakeFile, 'course-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects with 403 if caller is not the course instructor', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        instructorAddress: 'G_INST_1',
        instructor: { id: 'inst-1' },
      });

      const unauthorizedUser = { id: 'other-user', stellarAddress: 'G_OTHER', role: UserRole.INSTRUCTOR };

      await expect(
        controller.uploadCourseAsset({ user: unauthorizedUser }, fakeFile, 'course-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows upload if caller is the course instructor', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        instructorAddress: 'G_INST_1',
        instructor: { id: 'inst-1' },
      });

      const instructorUser = { id: 'inst-1', stellarAddress: 'G_INST_1', role: UserRole.INSTRUCTOR };

      const res = await controller.uploadCourseAsset({ user: instructorUser }, fakeFile, 'course-1');
      expect(res).toEqual({ url: 'https://cdn.example.com/asset.png' });
      expect(mockUploadsService.saveFile).toHaveBeenCalledWith(fakeFile, 'courses/course-1');
    });

    it('propagates validation errors from validateFile', async () => {
      mockUploadsService.validateFile.mockImplementationOnce(() => {
        throw new BadRequestException('File size exceeds maximum allowed size');
      });

      await expect(
        controller.uploadCourseAsset({ user: { id: 'inst-1' } }, fakeFile, 'course-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('uploadLessonVideo', () => {
    const fakeVideo = {
      originalname: 'lesson.mp4',
      mimetype: 'video/mp4',
      size: 5000,
      buffer: Buffer.from('video'),
    } as Express.Multer.File;

    it('rejects with 403 if caller does not own the course/lesson', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({
        id: 'lesson-1',
        module: {
          course: {
            id: 'course-1',
            instructorAddress: 'G_INST_1',
            instructor: { id: 'inst-1' },
          },
        },
      });

      const unauthorizedUser = { id: 'other-user', stellarAddress: 'G_OTHER', role: UserRole.INSTRUCTOR };

      await expect(
        controller.uploadLessonVideo({ user: unauthorizedUser }, fakeVideo, 'lesson-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows lesson video upload and returns transcode job info', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({
        id: 'lesson-1',
        module: {
          course: {
            id: 'course-1',
            instructorAddress: 'G_INST_1',
            instructor: { id: 'inst-1' },
          },
        },
      });

      const instructorUser = { id: 'inst-1', stellarAddress: 'G_INST_1', role: UserRole.INSTRUCTOR };

      const res = await controller.uploadLessonVideo({ user: instructorUser }, fakeVideo, 'lesson-1');
      expect(res).toEqual({ jobId: 'job-123', originUrl: '/uploads/video.mp4' });
      expect(mockUploadsService.saveVideo).toHaveBeenCalledWith(
        fakeVideo,
        'courses/course-1/lessons/lesson-1',
        'lesson-1',
      );
    });
  });

  describe('getVideoJobStatus', () => {
    it('returns 404 when job not found', async () => {
      mockVideoTranscodeService.getJobStatus.mockResolvedValue(null);

      await expect(controller.getVideoJobStatus('unknown-job')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns job status when found', async () => {
      mockVideoTranscodeService.getJobStatus.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        progress: 100,
      });

      const res = await controller.getVideoJobStatus('job-1');
      expect(res).toEqual({ id: 'job-1', status: 'completed', progress: 100 });
    });
  });

  describe('getScanStatus', () => {
    it('returns 404 when file scan record not found', async () => {
      mockVirusScanService.getScanStatus.mockResolvedValue(undefined);

      await expect(controller.getScanStatus('file-unknown')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns file scan record when found', async () => {
      mockVirusScanService.getScanStatus.mockResolvedValue({
        fileId: 'file-1',
        status: 'clean',
        attempts: 1,
      });

      const res = await controller.getScanStatus('file-1');
      expect(res).toEqual({ fileId: 'file-1', status: 'clean', attempts: 1 });
    });
  });
});
