import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SubmitCourseDto } from './submit-course.dto';
import { RejectCourseDto } from './reject-course.dto';

describe('Courses DTO Validation', () => {
  it('validates SubmitCourseDto with optional txHash', async () => {
    const validDto = plainToInstance(SubmitCourseDto, { txHash: '0xabc123' });
    const errors = await validate(validDto);
    expect(errors.length).toBe(0);

    const emptyDto = plainToInstance(SubmitCourseDto, {});
    const errorsEmpty = await validate(emptyDto);
    expect(errorsEmpty.length).toBe(0);

    const invalidDto = plainToInstance(SubmitCourseDto, { txHash: 12345 });
    const errorsInvalid = await validate(invalidDto);
    expect(errorsInvalid.length).toBeGreaterThan(0);
  });

  it('validates RejectCourseDto requires non-empty reason string', async () => {
    const valid = plainToInstance(RejectCourseDto, { reason: 'Insufficient video quality.' });
    expect(await validate(valid)).toHaveLength(0);

    const empty = plainToInstance(RejectCourseDto, { reason: '' });
    expect(await validate(empty)).not.toHaveLength(0);

    const missing = plainToInstance(RejectCourseDto, {});
    expect(await validate(missing)).not.toHaveLength(0);
  });
});
