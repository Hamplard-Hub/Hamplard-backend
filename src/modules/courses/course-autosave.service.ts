import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AutosaveCourseDto } from './dto/autosave-course.dto';

@Injectable()
export class CourseAutosaveService {
  private readonly logger = new Logger(CourseAutosaveService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Periodically autosaves in-progress course edits.
   * - Validates draft and course ownership.
   * - Manages optimistic concurrency control via version matching.
   * - Tracks lastSavedAt timestamp.
   */
  async autosave(
    instructorId: string,
    instructorAddress: string,
    dto: AutosaveCourseDto,
  ) {
    const now = new Date();

    // Case 1: Target a specific existing draft ID
    if (dto.draftId) {
      const existingDraft = await this.prisma.courseDraft.findUnique({
        where: { id: dto.draftId },
      });

      if (!existingDraft) {
        throw new NotFoundException(`Draft with ID ${dto.draftId} not found`);
      }

      // Ownership Validation
      if (existingDraft.instructorId !== instructorId) {
        throw new ForbiddenException('You do not have permission to modify this course draft.');
      }

      // Conflict Detection
      if (dto.version !== undefined && dto.version !== existingDraft.version) {
        throw new ConflictException(
          `Conflict detected: draft was modified by another session (expected version ${existingDraft.version}, received ${dto.version}).`,
        );
      }

      const updatedDraft = await this.prisma.courseDraft.update({
        where: { id: dto.draftId },
        data: {
          title: dto.title ?? existingDraft.title,
          data: dto.data,
          version: existingDraft.version + 1,
          lastSavedAt: now,
        },
      });

      this.logger.log(`Autosaved draft ${updatedDraft.id} (version ${updatedDraft.version}) for instructor ${instructorId}`);
      return updatedDraft;
    }

    // Case 2: Target an existing course by courseId
    if (dto.courseId) {
      const existingCourse = await this.prisma.course.findUnique({
        where: { id: dto.courseId },
      });

      if (existingCourse && existingCourse.instructorAddress !== instructorAddress) {
        throw new ForbiddenException('You do not have permission to modify this course.');
      }

      const existingDraft = await this.prisma.courseDraft.findFirst({
        where: { courseId: dto.courseId, instructorId },
      });

      if (existingDraft) {
        // Conflict Detection
        if (dto.version !== undefined && dto.version !== existingDraft.version) {
          throw new ConflictException(
            `Conflict detected: draft was modified by another session (expected version ${existingDraft.version}, received ${dto.version}).`,
          );
        }

        const updatedDraft = await this.prisma.courseDraft.update({
          where: { id: existingDraft.id },
          data: {
            title: dto.title ?? existingDraft.title,
            data: dto.data,
            version: existingDraft.version + 1,
            lastSavedAt: now,
          },
        });

        this.logger.log(`Autosaved course draft ${updatedDraft.id} for course ${dto.courseId}`);
        return updatedDraft;
      }

      // Create new draft for existing course
      const newDraft = await this.prisma.courseDraft.create({
        data: {
          courseId: dto.courseId,
          instructorId,
          instructorAddress,
          title: dto.title,
          data: dto.data,
          version: 1,
          lastSavedAt: now,
        },
      });

      this.logger.log(`Created autosave draft ${newDraft.id} for course ${dto.courseId}`);
      return newDraft;
    }

    // Case 3: Create a new unlinked course draft
    const newDraft = await this.prisma.courseDraft.create({
      data: {
        instructorId,
        instructorAddress,
        title: dto.title,
        data: dto.data,
        version: 1,
        lastSavedAt: now,
      },
    });

    this.logger.log(`Created new autosave draft ${newDraft.id} for instructor ${instructorId}`);
    return newDraft;
  }

  /**
   * Provides recovered draft on next login or session restore.
   */
  async getRecoveredDraft(instructorId: string, courseId?: string) {
    const whereCondition: any = { instructorId };
    if (courseId) {
      whereCondition.courseId = courseId;
    }

    const draft = await this.prisma.courseDraft.findFirst({
      where: whereCondition,
      orderBy: { lastSavedAt: 'desc' },
    });

    if (!draft) {
      return null;
    }

    // Ownership check
    if (draft.instructorId !== instructorId) {
      throw new ForbiddenException('You do not have permission to access this draft.');
    }

    return draft;
  }

  /**
   * Fetch specific draft by ID with ownership check.
   */
  async getDraftById(draftId: string, instructorId: string) {
    const draft = await this.prisma.courseDraft.findUnique({
      where: { id: draftId },
    });

    if (!draft) {
      throw new NotFoundException(`Draft ${draftId} not found`);
    }

    if (draft.instructorId !== instructorId) {
      throw new ForbiddenException('You do not have permission to access this draft.');
    }

    return draft;
  }

  /**
   * Discards an in-progress draft.
   */
  async discardDraft(draftId: string, instructorId: string) {
    await this.getDraftById(draftId, instructorId);

    await this.prisma.courseDraft.delete({
      where: { id: draftId },
    });

    return { message: `Draft ${draftId} successfully discarded` };
  }

  /**
   * Clears draft upon course submission or publication.
   */
  async clearDraftOnSubmit(courseId: string, instructorId: string) {
    await this.prisma.courseDraft.deleteMany({
      where: { courseId, instructorId },
    });
    this.logger.log(`Cleared autosaved drafts for course ${courseId}`);
  }
}
