import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterCredentialsDto } from './register-credentials.dto';

/**
 * Build the DTO the way the global ValidationPipe does (transform first, then
 * validate) so the whitespace-trimming behaviour is exercised for real.
 */
async function validateInput(input: Record<string, unknown>) {
  const dto = plainToInstance(RegisterCredentialsDto, input);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('RegisterCredentialsDto', () => {
  const base = { email: 'user@example.com', password: 'password123' };

  it('accepts a fullName and normalizes surrounding whitespace', async () => {
    const { dto, errors } = await validateInput({
      ...base,
      fullName: '  Ada Lovelace  ',
    });
    expect(errors).toHaveLength(0);
    // Trimmed on the instance, ready to store as user_metadata.full_name.
    expect(dto.fullName).toBe('Ada Lovelace');
  });

  it.each(['A', '  A  ', ''])(
    'rejects a fullName that is empty or trims below 2 characters (%j)',
    async (fullName) => {
      const { errors } = await validateInput({ ...base, fullName });
      const fullNameErrors = errors.find((e) => e.property === 'fullName');
      expect(fullNameErrors?.constraints).toHaveProperty(
        'minLength',
        'fullName must be at least 2 characters long',
      );
    },
  );

  it('rejects a whitespace-only fullName', async () => {
    const { errors } = await validateInput({ ...base, fullName: '     ' });
    const fullNameErrors = errors.find((e) => e.property === 'fullName');
    expect(fullNameErrors).toBeDefined();
    expect(fullNameErrors?.constraints).toHaveProperty(
      'isNotEmpty',
      'fullName is required',
    );
  });

  it('rejects a fullName over 100 characters', async () => {
    const { errors } = await validateInput({
      ...base,
      fullName: 'n'.repeat(101),
    });
    const fullNameErrors = errors.find((e) => e.property === 'fullName');
    expect(fullNameErrors?.constraints).toHaveProperty(
      'maxLength',
      'fullName must be at most 100 characters long',
    );
  });

  it('requires fullName', async () => {
    const { errors } = await validateInput({ ...base });
    const fullNameErrors = errors.find((e) => e.property === 'fullName');
    expect(fullNameErrors?.constraints).toHaveProperty(
      'isNotEmpty',
      'fullName is required',
    );
  });

  it('rejects a non-string fullName', async () => {
    const { errors } = await validateInput({ ...base, fullName: 42 });
    const fullNameErrors = errors.find((e) => e.property === 'fullName');
    expect(fullNameErrors?.constraints).toHaveProperty(
      'isString',
      'fullName must be a string',
    );
  });

  it('still enforces the inherited email/password rules', async () => {
    const { errors } = await validateInput({
      email: 'not-an-email',
      password: 'short',
      fullName: 'Ada Lovelace',
    });
    const properties = errors.map((e) => e.property);
    expect(properties).toContain('email');
    expect(properties).toContain('password');
    expect(properties).not.toContain('fullName');
  });
});
