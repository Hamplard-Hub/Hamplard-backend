import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateLessonDto } from './create-lesson.dto';

/**
 * All lesson fields are optional on update. The parent module cannot be
 * changed here — use the course reorder endpoint to move a lesson (#330).
 */
export class UpdateLessonDto extends PartialType(OmitType(CreateLessonDto, ['moduleId'] as const)) {}
