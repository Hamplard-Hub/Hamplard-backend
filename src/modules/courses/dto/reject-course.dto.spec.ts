import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  RejectCourseDto,
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from './reject-course.dto';

/** Issue #444 — validates the reject body exactly as the global pipe in main.ts does. */
describe('RejectCourseDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: RejectCourseDto });

  it('accepts a sufficiently long reason and trims surrounding whitespace', async () => {
    const dto = await validate({ reason: '   Missing intro video and captions   ' });
    expect(dto).toBeInstanceOf(RejectCourseDto);
    expect(dto.reason).toBe('Missing intro video and captions');
  });

  it.each([
    ['missing body field', {}],
    ['null reason', { reason: null }],
    ['empty string', { reason: '' }],
    ['whitespace only', { reason: '          ' }],
    ['number', { reason: 12345678901 }],
    ['object', { reason: { text: 'Missing intro video' } }],
    ['array', { reason: ['Missing intro video'] }],
  ])('rejects %s with 400', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`rejects reasons shorter than ${REJECTION_REASON_MIN_LENGTH} characters (after trimming)`, async () => {
    await expect(validate({ reason: 'Too short' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ reason: '   abc    ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`accepts exactly ${REJECTION_REASON_MIN_LENGTH} characters`, async () => {
    const reason = 'x'.repeat(REJECTION_REASON_MIN_LENGTH);
    await expect(validate({ reason })).resolves.toMatchObject({ reason });
  });

  it(`rejects reasons longer than ${REJECTION_REASON_MAX_LENGTH} characters`, async () => {
    await expect(
      validate({ reason: 'x'.repeat(REJECTION_REASON_MAX_LENGTH + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown properties', async () => {
    await expect(
      validate({ reason: 'A perfectly valid reason', status: 'ACTIVE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
