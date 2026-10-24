import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

describe('PaginationQueryDto', () => {
  it('should have default values of page=1 and limit=20', () => {
    const dto = new PaginationQueryDto();
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('should validate valid page and limit values', async () => {
    const plain = { page: '2', limit: '50' };
    const dto = plainToInstance(PaginationQueryDto, plain);
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
  });

  it('should accept boundary values limit=1 and limit=100', async () => {
    const minDto = plainToInstance(PaginationQueryDto, { page: 1, limit: 1 });
    const minErrors = await validate(minDto);
    expect(minErrors.length).toBe(0);

    const maxDto = plainToInstance(PaginationQueryDto, { page: 1, limit: 100 });
    const maxErrors = await validate(maxDto);
    expect(maxErrors.length).toBe(0);
  });

  it('should reject limit > 100 (including 1000000)', async () => {
    const dto101 = plainToInstance(PaginationQueryDto, { limit: 101 });
    const errors101 = await validate(dto101);
    expect(errors101.length).toBeGreaterThan(0);
    expect(errors101[0].constraints?.max).toBeDefined();

    const dtoMillion = plainToInstance(PaginationQueryDto, { limit: 1000000 });
    const errorsMillion = await validate(dtoMillion);
    expect(errorsMillion.length).toBeGreaterThan(0);
    expect(errorsMillion[0].constraints?.max).toBeDefined();
  });

  it('should reject limit < 1 (0 or negative)', async () => {
    const dtoZero = plainToInstance(PaginationQueryDto, { limit: 0 });
    const errorsZero = await validate(dtoZero);
    expect(errorsZero.length).toBeGreaterThan(0);
    expect(errorsZero[0].constraints?.min).toBeDefined();

    const dtoNegative = plainToInstance(PaginationQueryDto, { limit: -10 });
    const errorsNegative = await validate(dtoNegative);
    expect(errorsNegative.length).toBeGreaterThan(0);
    expect(errorsNegative[0].constraints?.min).toBeDefined();
  });

  it('should reject page < 1 (0 or negative)', async () => {
    const dtoZero = plainToInstance(PaginationQueryDto, { page: 0 });
    const errorsZero = await validate(dtoZero);
    expect(errorsZero.length).toBeGreaterThan(0);
    expect(errorsZero[0].constraints?.min).toBeDefined();

    const dtoNegative = plainToInstance(PaginationQueryDto, { page: -1 });
    const errorsNegative = await validate(dtoNegative);
    expect(errorsNegative.length).toBeGreaterThan(0);
    expect(errorsNegative[0].constraints?.min).toBeDefined();
  });

  it('should reject non-integer page or limit values', async () => {
    const dtoFloat = plainToInstance(PaginationQueryDto, { page: 1.5, limit: 20.5 });
    const errorsFloat = await validate(dtoFloat);
    expect(errorsFloat.length).toBeGreaterThan(0);

    const dtoString = plainToInstance(PaginationQueryDto, { page: 'abc', limit: 'xyz' });
    const errorsString = await validate(dtoString);
    expect(errorsString.length).toBeGreaterThan(0);
  });
});
