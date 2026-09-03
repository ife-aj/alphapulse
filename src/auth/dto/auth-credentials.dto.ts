import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * Email + password credentials, shared by registration and login.
 *
 * POST /api/auth/login uses this class directly. POST /api/auth/register uses
 * {@link RegisterCredentialsDto} (a subclass that adds fullName), so login never
 * accepts or requires a full name.
 *
 * Validation is enforced by the global ValidationPipe (whitelist + forbid
 * non-whitelisted), so extra fields are rejected with a 400 before the service
 * ever runs.
 */
export class AuthCredentialsDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Email address for the account.',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  email: string;

  @ApiProperty({
    example: 'a-secure-password',
    minLength: 8,
    description: 'Account password. Must be at least 8 characters.',
  })
  @IsString({ message: 'password must be a string' })
  @MinLength(8, { message: 'password must be at least 8 characters long' })
  password: string;
}
