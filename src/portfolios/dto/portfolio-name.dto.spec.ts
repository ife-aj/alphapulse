import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PortfolioNameDto } from './portfolio-name.dto';

/**
 * Mirror how the global ValidationPipe processes a body DTO: run the
 * class-transformer @Transform first, then class-validator's constraints.
 */
async function validateName(name: unknown) {
  const dto = plainToInstance(PortfolioNameDto, { name });
  const errors = await validate(dto);
  return { dto, errors };
}

describe('PortfolioNameDto', () => {
  it('trims surrounding whitespace', async () => {
    const { dto, errors } = await validateName('  Tech Holdings  ');
    expect(errors).toHaveLength(0);
    expect((dto as { name: string }).name).toBe('Tech Holdings');
  });

  it('rejects a whitespace-only name', async () => {
    const { errors } = await validateName('     ');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty string', async () => {
    const { errors } = await validateName('');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing name', async () => {
    const { errors } = await validateName(undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a name longer than 100 characters', async () => {
    const { errors } = await validateName('T'.repeat(101));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a name at exactly 100 characters', async () => {
    const { errors } = await validateName('T'.repeat(100));
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-string name', async () => {
    const { errors } = await validateName(42);
    expect(errors.length).toBeGreaterThan(0);
  });
});
