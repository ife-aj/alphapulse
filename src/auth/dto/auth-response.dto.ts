import { ApiProperty } from '@nestjs/swagger';

/** Safe public view of a user. Never includes passwords, tokens, or provider internals. */
export class AuthUserDto {
  @ApiProperty({ description: 'Supabase user UUID.' })
  id: string;

  @ApiProperty({ example: 'user@example.com', nullable: true })
  email: string | null;

  @ApiProperty({
    description: 'True once the user has confirmed their email address.',
    example: true,
  })
  emailConfirmed: boolean;

  @ApiProperty({
    description:
      'Full name from `user_metadata.full_name`; null when never set ' +
      '(e.g. accounts created before full names were collected).',
    example: 'Ada Lovelace',
    nullable: true,
  })
  fullName: string | null;

  @ApiProperty({ example: '2026-09-03T10:00:00.000Z', nullable: true })
  createdAt: string | null;
}

/** Session tokens returned only from register/login, never from /auth/me. */
export class AuthSessionDto {
  @ApiProperty({
    description: 'Bearer access token (JWT) for authenticated requests.',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Refresh token used to obtain a new access token.',
  })
  refreshToken: string;

  @ApiProperty({
    description: 'Epoch seconds at which the access token expires.',
  })
  expiresAt: number;
}

/** Payload for register/login responses. */
export class AuthResultDto {
  @ApiProperty({
    type: AuthUserDto,
    required: false,
    nullable: true,
    description:
      'The active account. Present whenever a session was issued. Null when ' +
      'email confirmation is required — the body is then identical whether the ' +
      'address is new or already registered, so it never reveals account existence.',
  })
  user: AuthUserDto | null;

  @ApiProperty({
    type: AuthSessionDto,
    required: false,
    nullable: true,
    description:
      'Present when the account is active. Null when email confirmation is required.',
  })
  session: AuthSessionDto | null;
}

/** Payload for GET /api/auth/me. */
export class MeResultDto {
  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;
}
