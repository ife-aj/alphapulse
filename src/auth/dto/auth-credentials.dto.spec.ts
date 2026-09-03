import { validate } from 'class-validator';
import { AuthCredentialsDto } from './auth-credentials.dto';

function makeDto(email?: string, password?: string): AuthCredentialsDto {
  const dto = new AuthCredentialsDto();
  dto.email = email as string;
  dto.password = password as string;
  return dto;
}

async function propertyErrors(dto: AuthCredentialsDto): Promise<string[]> {
  const errors = await validate(dto);
  return errors.map((error) => error.property);
}

describe('AuthCredentialsDto', () => {
  it('accepts a valid email and an 8+ character password', async () => {
    const errors = await validate(makeDto('user@example.com', 'password123'));
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid email', async () => {
    const dto = makeDto('not-an-email', 'password123');
    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);
    expect(properties).toContain('email');
    expect(errors[0].constraints).toHaveProperty(
      'isEmail',
      'email must be a valid email address',
    );
  });

  it.each(['short', '', '1234567'])(
    'rejects a password of %j (shorter than 8 characters)',
    async (password) => {
      const dto = makeDto('user@example.com', password);
      const errors = await validate(dto);
      const properties = errors.map((error) => error.property);
      expect(properties).toContain('password');
      const passwordErrors = errors.find((e) => e.property === 'password');
      expect(passwordErrors?.constraints).toHaveProperty(
        'minLength',
        'password must be at least 8 characters long',
      );
    },
  );

  it('rejects when email or password is missing', async () => {
    const missingEmail = await propertyErrors(
      makeDto(undefined, 'password123'),
    );
    expect(missingEmail).toContain('email');

    const missingPassword = await propertyErrors(makeDto('user@example.com'));
    expect(missingPassword).toContain('password');
  });
});
