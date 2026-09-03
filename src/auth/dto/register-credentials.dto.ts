import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthCredentialsDto } from './auth-credentials.dto';

/**
 * Request body for POST /api/auth/register: login credentials plus a full name.
 * Login keeps using {@link AuthCredentialsDto} directly, so fullName is never
 * required or accepted there.
 *
 * The global ValidationPipe transforms before it validates, so `fullName` is
 * trimmed first and the empty/whitespace-only rejection and the length checks
 * run against the normalized value that is stored as `user_metadata.full_name`.
 */
export class RegisterCredentialsDto extends AuthCredentialsDto {
  @ApiProperty({
    example: 'Ada Lovelace',
    minLength: 2,
    maxLength: 100,
    description:
      "The user's full name. Trimmed of surrounding whitespace; must be " +
      '2–100 characters and contain at least one non-whitespace character.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'fullName must be a string' })
  @IsNotEmpty({ message: 'fullName is required' })
  @MinLength(2, { message: 'fullName must be at least 2 characters long' })
  @MaxLength(100, { message: 'fullName must be at most 100 characters long' })
  fullName: string;
}
