import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from './auth.service';
import type { AuthCredentialsDto } from './dto/auth-credentials.dto';
import type { RegisterCredentialsDto } from './dto/register-credentials.dto';

/**
 * AuthService unit tests. SupabaseService is mocked so no live Supabase call is
 * ever made. The tests drive the real error-mapping code in supabase-auth-errors
 * by returning realistic Supabase-shaped error objects.
 */

const credentials: AuthCredentialsDto = {
  email: 'user@example.com',
  password: 'password123',
};

// Register credentials carry a full name; login credentials never do.
const registerCredentials: RegisterCredentialsDto = {
  ...credentials,
  fullName: '  Ada Lovelace  ',
};

// A realistic (but fake) Supabase user. Extra fields are included deliberately:
// they must never leak into the response. user_metadata mirrors what signUp
// stores for this account (full_name set by register).
const confirmedUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'user@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  user_metadata: { full_name: 'Ada Lovelace' },
  app_metadata: { provider: 'email', providers: ['email'] },
  aud: 'authenticated',
  role: 'authenticated',
};

const unconfirmedUser = { ...confirmedUser, email_confirmed_at: null };

const session = {
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: confirmedUser,
};

const safeUserView = {
  id: confirmedUser.id,
  email: 'user@example.com',
  emailConfirmed: true,
  fullName: 'Ada Lovelace',
  createdAt: '2026-09-02T10:00:00.000Z',
};

const supabaseError = (
  message: string,
  status: number,
  name = 'AuthApiError',
) => ({
  message,
  status,
  name,
  __isAuthError: true,
});

describe('AuthService', () => {
  let createAuthClient: jest.Mock;
  let signUp: jest.Mock;
  let signInWithPassword: jest.Mock;
  let getUser: jest.Mock;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    signUp = jest.fn();
    signInWithPassword = jest.fn();
    getUser = jest.fn();
    const authClient = { auth: { signUp, signInWithPassword, getUser } };
    createAuthClient = jest.fn().mockReturnValue(authClient);
    const supabase = {
      createAuthClient,
      // The singleton client is never used by auth ops.
      client: {},
    } as unknown as SupabaseService;
    service = new AuthService(supabase);
  });

  describe('register', () => {
    it('passes a trimmed full name to Supabase and returns a safe view', async () => {
      signUp.mockResolvedValue({
        data: { user: confirmedUser, session },
        error: null,
      });

      const result = await service.register(registerCredentials);

      expect(createAuthClient).toHaveBeenCalledTimes(1);
      expect(signUp).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
        options: {
          data: { full_name: 'Ada Lovelace' }, // surrounding whitespace trimmed
        },
      });
      // Exact match proves no provider/internal fields leak into the response.
      expect(result).toEqual({
        user: safeUserView,
        session: {
          accessToken: 'access-token-value',
          refreshToken: 'refresh-token-value',
          expiresAt: 2_000_000_000,
        },
      });
    });

    it('returns a neutral confirmation-required response when email confirmation is required', async () => {
      signUp.mockResolvedValue({
        data: { user: unconfirmedUser, session: null },
        error: null,
      });

      const result = await service.register(registerCredentials);

      // Identical to the response for an already-registered address: nothing in
      // the body can distinguish a fresh signup from an existing account, and no
      // metadata (full_name included) is exposed.
      expect(result).toEqual({ user: null, session: null });
    });

    it('never reveals an existing confirmed account via an obfuscated signUp success', async () => {
      // With confirmations enabled, Supabase answers sign-up of an existing
      // confirmed address with a success (200, no error, no session) carrying a
      // fake user (`identities: []` marks it). Its id / confirmation state /
      // creation date / metadata must not reach the response.
      const existingAccount = {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        email: credentials.email,
        email_confirmed_at: '2024-01-15T09:30:00.000Z',
        created_at: '2023-11-02T08:00:00.000Z',
        user_metadata: { full_name: 'Existing Member', other: 'secret' },
        identities: [],
        aud: 'authenticated',
        role: 'authenticated',
      };
      signUp.mockResolvedValue({
        data: { user: existingAccount, session: null },
        error: null,
      });

      const result = await service.register(registerCredentials);

      expect(result).toEqual({ user: null, session: null });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(existingAccount.id);
      expect(serialized).not.toContain('2024-01-15');
      expect(serialized).not.toContain('2023-11-02');
      expect(serialized).not.toContain('identities');
      expect(serialized).not.toContain('Existing Member');
      expect(serialized).not.toContain('secret');
    });

    it('maps an explicit already-registered error to a 409 ConflictException', async () => {
      signUp.mockResolvedValue({
        data: { user: null, session: null },
        error: supabaseError('User already registered', 400),
      });

      const attempt = service.register(registerCredentials);
      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(attempt).rejects.toThrow(
        'An account with this email already exists.',
      );
    });
  });

  describe('login', () => {
    it('returns a user + session on successful signInWithPassword', async () => {
      signInWithPassword.mockResolvedValue({
        data: { user: confirmedUser, session },
        error: null,
      });

      const result = await service.login(credentials);

      expect(createAuthClient).toHaveBeenCalledTimes(1);
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
      });
      expect(result).toEqual({
        user: safeUserView,
        session: {
          accessToken: 'access-token-value',
          refreshToken: 'refresh-token-value',
          expiresAt: 2_000_000_000,
        },
      });
    });

    it('maps invalid credentials to a 401 UnauthorizedException', async () => {
      signInWithPassword.mockResolvedValue({
        data: { user: null, session: null },
        error: supabaseError('Invalid login credentials', 400),
      });

      const attempt = service.login(credentials);
      await expect(attempt).rejects.toThrow(UnauthorizedException);
      await expect(attempt).rejects.toThrow('Email or password is incorrect.');
    });
  });

  describe('verifyAccessToken', () => {
    it('returns the safe user (fullName included) for a valid token', async () => {
      getUser.mockResolvedValue({
        data: { user: confirmedUser },
        error: null,
      });

      const result = await service.verifyAccessToken('valid-token');

      expect(getUser).toHaveBeenCalledWith('valid-token');
      expect(result).toEqual(safeUserView);
    });

    it('returns fullName null for an older account without user_metadata.full_name', async () => {
      getUser.mockResolvedValue({
        data: { user: { ...confirmedUser, user_metadata: {} } },
        error: null,
      });

      const result = await service.verifyAccessToken('valid-token');

      expect(result.fullName).toBeNull();
      // The rest of the safe view is untouched.
      expect(result).toEqual({ ...safeUserView, fullName: null });
    });

    it('rejects an invalid/expired token with a 401', async () => {
      getUser.mockResolvedValue({
        data: { user: null },
        error: supabaseError('JWT expired', 401),
      });

      await expect(service.verifyAccessToken('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.verifyAccessToken('expired-token')).rejects.toThrow(
        'Invalid or expired access token.',
      );
    });
  });

  it('uses a fresh auth client for every operation (no shared-session reuse)', async () => {
    signUp.mockResolvedValue({
      data: { user: confirmedUser, session },
      error: null,
    });
    signInWithPassword.mockResolvedValue({
      data: { user: confirmedUser, session },
      error: null,
    });
    getUser.mockResolvedValue({ data: { user: confirmedUser }, error: null });

    await service.register(registerCredentials);
    await service.login(credentials);
    await service.verifyAccessToken('token');

    // One isolated client per operation — three operations, three fresh clients.
    expect(createAuthClient).toHaveBeenCalledTimes(3);
  });
});
