import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { AuthCredentialsDto } from './dto/auth-credentials.dto';
import type { RegisterCredentialsDto } from './dto/register-credentials.dto';
import type {
  AuthResultDto,
  AuthSessionDto,
  AuthUserDto,
} from './dto/auth-response.dto';
import {
  isRetryableAuthError,
  toAuthHttpException,
} from './supabase-auth-errors';

/** The minimal slices of the Supabase wire shapes this service reads. */
interface SupabaseUserLike {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  created_at?: string | null;
  user_metadata?: { full_name?: unknown } | null;
}

interface SupabaseSessionLike {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number | null;
}

/**
 * The only safe slice of `user_metadata` we ever expose: `full_name`, and only
 * when it is a non-blank string. Everything else in user_metadata is dropped.
 */
function toFullName(user: SupabaseUserLike): string | null {
  const raw = user.user_metadata?.full_name;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Map a Supabase user onto the safe public DTO, dropping every internal field. */
function toUserDto(user: SupabaseUserLike): AuthUserDto {
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmed: Boolean(user.email_confirmed_at),
    fullName: toFullName(user),
    createdAt: user.created_at ?? null,
  };
}

function toSessionDto(session: SupabaseSessionLike): AuthSessionDto {
  const fallbackTtlSeconds = 3600;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt:
      session.expires_at ??
      nowSeconds + (session.expires_in ?? fallbackTtlSeconds),
  };
}

/**
 * AlphaPulse authentication against Supabase Auth.
 *
 * Every operation runs on a *fresh* client obtained from
 * `SupabaseService.createAuthClient()`. Supabase retains the signed-in session
 * in memory on whichever client performed the call, so a shared client could
 * leak one request's session into another concurrent request. A client per
 * operation makes cross-request leakage impossible. The shared singleton client
 * is never used here.
 */
@Injectable()
export class AuthService {
  constructor(private readonly supabase: SupabaseService) {}

  async register(credentials: RegisterCredentialsDto): Promise<AuthResultDto> {
    const client = this.supabase.createAuthClient();
    // The DTO is trimmed at the boundary; trim again so the value stored as
    // user_metadata.full_name is normalized even when register is called with an
    // untrimmed DTO directly.
    const normalizedFullName = credentials.fullName.trim();
    const { data, error } = await client.auth.signUp({
      email: credentials.email,
      password: credentials.password,
      options: {
        data: {
          full_name: normalizedFullName,
        },
      },
    });

    if (error) {
      throw toAuthHttpException(error);
    }

    // No session: Supabase requires email confirmation. A brand-new address
    // lands here (a real, unconfirmed user). So does an existing *confirmed*
    // address when confirmations are enabled — Supabase deliberately returns the
    // same success-without-session to stop email enumeration, and the two cases
    // are indistinguishable to us. Answer both identically and neutrally: never
    // echo id / created_at / email_confirmed_at, any of which would reveal
    // whether the address already has an account.
    if (!data?.session) {
      return { user: null, session: null };
    }

    // A session always belongs to a user; a missing one here is a provider bug.
    const user = data.user ?? data.session.user;
    if (!user) {
      throw new InternalServerErrorException(
        'Registration did not return a user.',
      );
    }

    return {
      user: toUserDto(user as unknown as SupabaseUserLike),
      session: toSessionDto(data.session as unknown as SupabaseSessionLike),
    };
  }

  async login(credentials: AuthCredentialsDto): Promise<AuthResultDto> {
    const client = this.supabase.createAuthClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    });

    if (error) {
      throw toAuthHttpException(error);
    }
    if (!data?.session) {
      throw new InternalServerErrorException('Login did not return a session.');
    }

    const user = data.user ?? data.session.user;
    if (!user) {
      throw new InternalServerErrorException('Login did not return a user.');
    }

    return {
      user: toUserDto(user as unknown as SupabaseUserLike),
      session: toSessionDto(data.session as unknown as SupabaseSessionLike),
    };
  }

  /**
   * Validate a bearer access token against Supabase Auth and return the safe
   * user view. Used by SupabaseAuthGuard. Every error path is a 401 except a
   * genuine Supabase outage, which stays a 5xx so clients can tell "your token
   * is bad" from "auth is down".
   */
  async verifyAccessToken(accessToken: string): Promise<AuthUserDto> {
    const client = this.supabase.createAuthClient();
    const { data, error } = await client.auth.getUser(accessToken);

    if (error) {
      if (isRetryableAuthError(error)) {
        throw toAuthHttpException(error);
      }
      throw new UnauthorizedException('Invalid or expired access token.');
    }
    if (!data?.user) {
      throw new UnauthorizedException('Invalid or expired access token.');
    }

    return toUserDto(data.user as unknown as SupabaseUserLike);
  }
}
