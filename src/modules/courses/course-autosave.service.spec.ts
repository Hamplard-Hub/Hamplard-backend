import { Test, TestingModule } from '@nestjs/testing';
import { CourseAutosaveService } from './course-autosave.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

const mockPrisma = {
  courseDraft: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  course: {
    findUnique: jest.fn(),
  },
};

const MOCK_INSTRUCTOR_ID = 'usr-instructor-1212';
const MOCK_STELLAR_ADDR = 'GABC1234567890';
const MOCK_DRAFT = {
  id: 'draft-uuid-001',
  courseId: 'course-123',
  instructorId: MOCK_INSTRUCTOR_ID,
  instructorAddress: MOCK_STELLAR_ADDR,
  title: 'Tailoring 101',
  data: { title: 'Tailoring 101', category: 'Crafts' },
  version: 1,
  lastSavedAt: new Date('2026-08-25T10:00:00Z'),
  createdAt: new Date('2026-08-25T10:00:00Z'),
  updatedAt: new Date('2026-08-25T10:00:00Z'),
};

const MOCK_COURSE = {
  id: 'course-123',
  instructorAddress: MOCK_STELLAR_ADDR,
  title: 'Tailoring 101',
  category: 'Crafts',
  price: 50,
};

describe('CourseAutosaveService', () => {
  let service: CourseAutosaveService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CourseAutosaveService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CourseAutosaveService>(CourseAutosaveService);
    jest.clearAllMocks();
  });

  describe('autosave()', () => {
    it('creates a new unlinked draft when no draftId or courseId is provided', async () => {
      mockPrisma.courseDraft.create.mockResolvedValue({
        ...MOCK_DRAFT,
        id: 'new-draft-id',
        courseId: null,
      });

      const dto = {
        title: 'New Course',
        data: { title: 'New Course' },
      };

      const result = await service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto);
      expect(result.id).toBe('new-draft-id');
      expect(mockPrisma.courseDraft.create).toHaveBeenCalledTimes(1);
    });

    it('updates an existing draft by draftId and increments version', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue(MOCK_DRAFT);
      mockPrisma.courseDraft.update.mockResolvedValue({
        ...MOCK_DRAFT,
        version: 2,
        title: 'Updated Title',
      });

      const dto = {
        draftId: 'draft-uuid-001',
        title: 'Updated Title',
        data: { title: 'Updated Title' },
        version: 1,
      };

      const result = await service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto);
      expect(result.version).toBe(2);
      expect(mockPrisma.courseDraft.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'draft-uuid-001' },
          data: expect.objectContaining({ version: 2 }),
        }),
      );
    });

    it('throws NotFoundException when provided draftId does not exist', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue(null);

      const dto = {
        draftId: 'non-existent-id',
        data: { title: 'Draft' },
      };

      await expect(
        service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('validates draft ownership and throws ForbiddenException if user is not owner', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue({
        ...MOCK_DRAFT,
        instructorId: 'other-user-id',
      });

      const dto = {
        draftId: 'draft-uuid-001',
        data: { title: 'Draft' },
      };

      await expect(
        service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('detects concurrent edits and throws ConflictException if version does not match', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue({
        ...MOCK_DRAFT,
        version: 5,
      });

      const dto = {
        draftId: 'draft-uuid-001',
        data: { title: 'Draft' },
        version: 4, // Stale version from client
      };

      await expect(
        service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto),
      ).rejects.toThrow(ConflictException);
    });

    it('validates course ownership when courseId is provided', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        ...MOCK_COURSE,
        instructorAddress: 'OTHER_ADDRESS',
      });

      const dto = {
        courseId: 'course-123',
        data: { title: 'Unauthorized update' },
      };

      await expect(
        service.autosave(MOCK_INSTRUCTOR_ID, MOCK_STELLAR_ADDR, dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getRecoveredDraft()', () => {
    it('returns recovered draft for user on next login', async () => {
      mockPrisma.courseDraft.findFirst.mockResolvedValue(MOCK_DRAFT);

      const result = await service.getRecoveredDraft(MOCK_INSTRUCTOR_ID);
      expect(result).toEqual(MOCK_DRAFT);
      expect(mockPrisma.courseDraft.findFirst).toHaveBeenCalledWith({
        where: { instructorId: MOCK_INSTRUCTOR_ID },
        orderBy: { lastSavedAt: 'desc' },
      });
    });

    it('returns null if no draft exists', async () => {
      mockPrisma.courseDraft.findFirst.mockResolvedValue(null);

      const result = await service.getRecoveredDraft(MOCK_INSTRUCTOR_ID);
      expect(result).toBeNull();
    });
  });

  describe('getDraftById()', () => {
    it('fetches draft by ID when owned by user', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue(MOCK_DRAFT);

      const result = await service.getDraftById('draft-uuid-001', MOCK_INSTRUCTOR_ID);
      expect(result).toEqual(MOCK_DRAFT);
    });

    it('throws NotFoundException if draft does not exist', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue(null);

      await expect(
        service.getDraftById('invalid-id', MOCK_INSTRUCTOR_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if draft belongs to another user', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue({
        ...MOCK_DRAFT,
        instructorId: 'other-user',
      });

      await expect(
        service.getDraftById('draft-uuid-001', MOCK_INSTRUCTOR_ID),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('discardDraft()', () => {
    it('deletes draft successfully after ownership check', async () => {
      mockPrisma.courseDraft.findUnique.mockResolvedValue(MOCK_DRAFT);
      mockPrisma.courseDraft.delete.mockResolvedValue(MOCK_DRAFT);

      const result = await service.discardDraft('draft-uuid-001', MOCK_INSTRUCTOR_ID);
      expect(result.message).toContain('successfully discarded');
      expect(mockPrisma.courseDraft.delete).toHaveBeenCalledWith({
        where: { id: 'draft-uuid-001' },
      });
    });
  });

  describe('clearDraftOnSubmit()', () => {
    it('deletes all autosaved drafts for course', async () => {
      mockPrisma.courseDraft.deleteMany.mockResolvedValue({ count: 1 });

      await service.clearDraftOnSubmit('course-123', MOCK_INSTRUCTOR_ID);
      expect(mockPrisma.courseDraft.deleteMany).toHaveBeenCalledWith({
        where: { courseId: 'course-123', instructorId: MOCK_INSTRUCTOR_ID },
      });
    });
  });
});
