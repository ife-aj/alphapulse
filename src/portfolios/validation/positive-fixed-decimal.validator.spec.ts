import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  IsOptionalPositiveFixedDecimal,
  IsPositiveFixedDecimal,
} from './positive-fixed-decimal.validator';

class RequiredHolder {
  @IsPositiveFixedDecimal()
  amount?: number;
}

class OptionalHolder {
  @IsOptionalPositiveFixedDecimal()
  amount?: number;
}

async function validateRequired(value: unknown) {
  const dto = plainToInstance(RequiredHolder, { amount: value });
  return validate(dto);
}

async function validateOptional(value: unknown) {
  const dto = plainToInstance(OptionalHolder, { amount: value });
  return validate(dto);
}

describe('IsPositiveFixedDecimal (required)', () => {
  it.each([0.5, 12.5, 152.3755, 1, 0.000001, 999999999999])(
    'accepts a valid positive fixed-point number %p',
    async (value) => {
      const errors = await validateRequired(value);
      expect(errors).toHaveLength(0);
    },
  );

  it.each([undefined, null, 0, -1, -0.000001, 0.0000001, 1.1234567])(
    'rejects %p (not a finite positive fixed-point number)',
    async (value) => {
      const errors = await validateRequired(value);
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    'rejects the non-finite number %p',
    async (value) => {
      const errors = await validateRequired(value);
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['12.5', {}, [], true])('rejects the non-number %j', async (value) => {
    const errors = await validateRequired(value);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a magnitude with 13 integer digits (over numeric(18,6))', async () => {
    const errors = await validateRequired(1000000000000);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects more than six decimal places', async () => {
    const errors = await validateRequired(1.0000001);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('IsOptionalPositiveFixedDecimal (skips only undefined)', () => {
  it('accepts a valid value', async () => {
    expect(await validateOptional(15)).toHaveLength(0);
  });

  it('skips a truly absent field (undefined)', async () => {
    const dto = plainToInstance(OptionalHolder, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('does NOT treat null as absent — null rejects', async () => {
    const errors = await validateOptional(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([0, -1, NaN, Infinity, 1.1234567, 1000000000000])(
    'rejects the invalid optional value %p',
    async (value) => {
      const errors = await validateOptional(value);
      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
