import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateLessonThumbnailDto } from './update-lesson-thumbnail.dto';
import { CompleteLessonDto } from './complete-lesson.dto';
import { RecordLessonProgressDto } from './record-lesson-progress.dto';

describe('Lessons DTO Validation', () => {
  it('validates UpdateLessonThumbnailDto requires non-empty thumbnailUrl', async () => {
    const valid = plainToInstance(UpdateLessonThumbnailDto, { thumbnailUrl: 'https://example.com/pic.jpg' });
    expect(await validate(valid)).toHaveLength(0);

    const empty = plainToInstance(UpdateLessonThumbnailDto, { thumbnailUrl: '' });
    expect(await validate(empty)).not.toHaveLength(0);
  });

  it('validates CompleteLessonDto', async () => {
    const valid = plainToInstance(CompleteLessonDto, { enrollmentId: 'e-1', watchedSecs: 120 });
    expect(await validate(valid)).toHaveLength(0);

    const missingEnrollment = plainToInstance(CompleteLessonDto, { watchedSecs: 120 });
    expect(await validate(missingEnrollment)).not.toHaveLength(0);

    const negativeWatched = plainToInstance(CompleteLessonDto, { enrollmentId: 'e-1', watchedSecs: -5 });
    expect(await validate(negativeWatched)).not.toHaveLength(0);
  });

  it('validates RecordLessonProgressDto requires positive watchedSecs', async () => {
    const valid = plainToInstance(RecordLessonProgressDto, { enrollmentId: 'e-1', watchedSecs: 300 });
    expect(await validate(valid)).toHaveLength(0);

    const missingWatched = plainToInstance(RecordLessonProgressDto, { enrollmentId: 'e-1' });
    expect(await validate(missingWatched)).not.toHaveLength(0);
  });
});
