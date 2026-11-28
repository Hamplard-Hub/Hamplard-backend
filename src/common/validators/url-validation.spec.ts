import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCourseDto } from '../../modules/courses/dto/create-course.dto';
import { UpdateCourseDto } from '../../modules/courses/dto/update-course.dto';
import { CreateLessonDto } from '../../modules/lessons/dto/create-lesson.dto';

describe('URL fields', () => {
  const cases: Array<{
    label: string;
    dto: new () => object;
    requiredFields: Record<string, string | number>;
    urlFields: string[];
  }> = [
    {
      label: 'course creation',
      dto: CreateCourseDto,
      requiredFields: { courseId: 'course-1', title: 'Course', category: 'Art', price: 0 },
      urlFields: ['thumbnailUrl', 'previewVideoUrl'],
    },
    {
      label: 'course updates',
      dto: UpdateCourseDto,
      requiredFields: {},
      urlFields: ['thumbnailUrl', 'previewVideoUrl'],
    },
    {
      label: 'lesson creation',
      dto: CreateLessonDto,
      requiredFields: { moduleId: 'module-1', title: 'Lesson', position: 0 },
      urlFields: ['videoUrl', 'thumbnailUrl', 'resourceUrl'],
    },
  ];

  it.each(cases)('$label accepts HTTPS URLs and rejects unsafe protocols', async ({
    dto,
    requiredFields,
    urlFields,
  }) => {
    for (const field of urlFields) {
      const validateField = async (value: string) => {
        const instance = plainToInstance(dto, { ...requiredFields, [field]: value });
        const errors = await validate(instance);
        return errors.some((error) => error.property === field);
      };

      expect(await validateField('https://cdn.example.com/resource')).toBe(false);
      expect(await validateField('http://127.0.0.1/resource')).toBe(
        process.env.NODE_ENV !== 'development',
      );
      expect(await validateField('javascript:alert(1)')).toBe(true);
    }
  });
});
