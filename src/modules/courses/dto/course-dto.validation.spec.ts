import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateCourseDto } from './create-course.dto';
import { UpdateCourseDto } from './update-course.dto';
import { COURSE_LEVELS } from '../course-validation.constants';

const validCourse = {
  courseId: 'COURSE-TAILORING-001',
  title: 'Professional Tailoring from Scratch',
  category: 'Tailoring',
  price: 50,
};

async function errorsFor(dtoClass: any, plain: Record<string, unknown>) {
  return validate(plainToInstance(dtoClass, plain));
}

function hasErrorOn(errors: ValidationError[], property: string) {
  return errors.some((error) => error.property === property);
}

describe('Course DTO validation (issue #448)', () => {
  describe('CreateCourseDto', () => {
    it('accepts a URL-safe courseId, every documented level and a 2-decimal price', async () => {
      for (const level of COURSE_LEVELS) {
        const errors = await errorsFor(CreateCourseDto, { ...validCourse, level });
        expect(errors).toHaveLength(0);
      }
    });

    it('accepts lowercase ids already used by seeded courses and length boundaries', async () => {
      for (const courseId of [
        'course-tailoring-101',
        'ABC',
        'A'.repeat(64),
      ]) {
        const errors = await errorsFor(CreateCourseDto, { ...validCourse, courseId });
        expect(errors).toHaveLength(0);
      }
    });

    it.each([
      ['a space', 'COURSE TAILORING'],
      ['a slash', 'COURSE/TAILORING'],
      ['a query separator', 'COURSE?ID=1'],
      ['a dot', 'COURSE.001'],
      ['fewer than 3 characters', 'AB'],
      ['more than 64 characters', 'A'.repeat(65)],
      ['a 10 KB string', 'A'.repeat(10 * 1024)],
      ['an empty string', ''],
      ['a trailing newline', 'COURSE-001\n'],
    ])('rejects courseId containing %s', async (_label, courseId) => {
      const errors = await errorsFor(CreateCourseDto, { ...validCourse, courseId });
      expect(hasErrorOn(errors, 'courseId')).toBe(true);
    });

    it('rejects a non-string courseId', async () => {
      const errors = await errorsFor(CreateCourseDto, { ...validCourse, courseId: 123 });
      expect(hasErrorOn(errors, 'courseId')).toBe(true);
    });

    it.each(['expert', 'beginner', 'Advanced ', '', 1])(
      'rejects unsupported level %p',
      async (level) => {
        const errors = await errorsFor(CreateCourseDto, { ...validCourse, level });
        expect(hasErrorOn(errors, 'level')).toBe(true);
      },
    );

    it.each(['English', 'French', 'en', 'en-US', 'pt-BR'])(
      'accepts language %p',
      async (language) => {
        const errors = await errorsFor(CreateCourseDto, { ...validCourse, language });
        expect(errors).toHaveLength(0);
      },
    );

    it.each(['English US', 'English/US', 'E', 'A'.repeat(10 * 1024)])(
      'rejects malformed language %p',
      async (language) => {
        const errors = await errorsFor(CreateCourseDto, { ...validCourse, language });
        expect(hasErrorOn(errors, 'language')).toBe(true);
      },
    );

    it.each([0, 50, 50.5, 50.99])('accepts price %p', async (price) => {
      const errors = await errorsFor(CreateCourseDto, { ...validCourse, price });
      expect(errors).toHaveLength(0);
    });

    it.each([50.999, -0.01, NaN, '50.00'])('rejects price %p', async (price) => {
      const errors = await errorsFor(CreateCourseDto, { ...validCourse, price });
      expect(hasErrorOn(errors, 'price')).toBe(true);
    });
  });

  describe('UpdateCourseDto', () => {
    it('accepts an empty patch and documented values', async () => {
      expect(await errorsFor(UpdateCourseDto, {})).toHaveLength(0);
      expect(
        await errorsFor(UpdateCourseDto, { level: 'Advanced', price: 99.95 }),
      ).toHaveLength(0);
    });

    it('rejects an unsupported level', async () => {
      const errors = await errorsFor(UpdateCourseDto, { level: 'Expert' });
      expect(hasErrorOn(errors, 'level')).toBe(true);
    });

    it('rejects a price with more than 2 decimal places or a negative price', async () => {
      const tooPrecise = await errorsFor(UpdateCourseDto, { price: 12.345 });
      const negative = await errorsFor(UpdateCourseDto, { price: -1 });
      expect(hasErrorOn(tooPrecise, 'price')).toBe(true);
      expect(hasErrorOn(negative, 'price')).toBe(true);
    });
  });
});
