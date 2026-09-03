import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * Auth endpoints end-to-end. SupabaseService is overridden with a mock, so the
 * suite never talks to the live Supabase project. These tests prove the real
 * HTTP contracts (routes, status codes, and the public body shape) a client
 * receives, and that no Supabase internals leak into responses.
 */

// Login is email + password only. Register additionally requires a full name.
const credentials = { email: 'user@example.com', password: 'password123' };
const registerCredentials = {
  ...credentials,
  fullName: '  Ada Lovelace  ', // surrounding whitespace is trimmed on input
};

// Realistic-but-fake Supabase users. Extra fields (password, provider_token,
// app_metadata) are included deliberately — they must never appear in a body.
const userA = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'user@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Ada Lovelace' },
  password: 'do-not-leak',
  provider_token: 'do-not-leak',
};

// An older account created before full names were collected: no metadata name.
const userB = {
  ...userA,
  id: '22222222-2222-2222-2222-222222222222',
  email: 'other@example.com',
  user_metadata: {},
};

const safeUserA = {
  id: userA.id,
  email: 'user@example.com',
  emailConfirmed: true,
  fullName: 'Ada Lovelace',
  createdAt: '2026-09-02T10:00:00.000Z',
};

const safeUserB = {
  id: userB.id,
  email: 'other@example.com',
  emailConfirmed: true,
  fullName: null,
  createdAt: '2026-09-02T10:00:00.000Z',
};

const session = {
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: userA,
};

const authApiError = (message: string, status: number) => ({
  message,
  status,
  name: 'AuthApiError',
  __isAuthError: true,
});

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let supabaseMock: {
    client: Record<string, never>;
    createAuthClient: jest.Mock;
    createUserClient: jest.Mock;
  };
  let authApi: {
    signUp: jest.Mock;
    signInWithPassword: jest.Mock;
    getUser: jest.Mock;
  };

  beforeEach(async () => {
    authApi = {
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      getUser: jest.fn().mockImplementation(async (token: string) => {
        const user =
          token === 'token-a' ? userA : token === 'token-b' ? userB : null;
        if (user) return { data: { user }, error: null };
        return {
          data: { user: null },
          error: authApiError('JWT invalid', 401),
        };
      }),
    };
    supabaseMock = {
      client: {},
      createAuthClient: jest.fn().mockReturnValue({ auth: authApi }),
      createUserClient: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabaseMock)
      .compile();

    app = moduleFixture.createNestApplication();
    // Mirror the production bootstrap in main.ts.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('creates an account and returns a safe user + session (201)', async () => {
      authApi.signUp.mockResolvedValue({
        data: { user: userA, session },
        error: null,
      });

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(registerCredentials)
        .expect(201)
        .expect(({ body }) => {
          // fullName is trimmed before being stored as user_metadata.full_name.
          expect(authApi.signUp).toHaveBeenCalledWith({
            email: 'user@example.com',
            password: 'password123',
            options: { data: { full_name: 'Ada Lovelace' } },
          });
          expect(body.user).toEqual(safeUserA);
          expect(body.session).toEqual({
            accessToken: 'access-token-value',
            refreshToken: 'refresh-token-value',
            expiresAt: 2_000_000_000,
          });
          // No passwords, tokens, or Supabase internals (metadata included).
          const serialized = JSON.stringify(body);
          expect(serialized).not.toContain('password');
          expect(serialized).not.toContain('do-not-leak');
          expect(serialized).not.toContain('app_metadata');
          expect(serialized).not.toContain('provider_token');
          expect(serialized).not.toContain('user_metadata');
          expect(serialized).not.toContain('full_name');
        });
    });

    it('returns 201 with a neutral body when email confirmation is required', async () => {
      authApi.signUp.mockResolvedValue({
        data: { user: { ...userA, email_confirmed_at: null }, session: null },
        error: null,
      });

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(registerCredentials)
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual({ user: null, session: null });
        });
    });

    it('returns the same neutral body for an existing confirmed email (no enumeration)', async () => {
      // When confirmations are enabled, Supabase answers an existing confirmed
      // address with a success that has no session (a fake user, identities: []).
      // The response must be byte-identical to a fresh unconfirmed signup so it
      // cannot reveal that the email already has an account — its metadata
      // (full_name included) must not surface either.
      const existingAccount = {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        email: credentials.email,
        email_confirmed_at: '2024-01-15T09:30:00.000Z',
        created_at: '2023-11-02T08:00:00.000Z',
        user_metadata: { full_name: 'Hidden Member', other: 'secret' },
        identities: [],
        password: 'do-not-leak',
      };
      authApi.signUp.mockResolvedValue({
        data: { user: existingAccount, session: null },
        error: null,
      });

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(registerCredentials)
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual({ user: null, session: null });
          const serialized = JSON.stringify(body);
          expect(serialized).not.toContain(existingAccount.id);
          expect(serialized).not.toContain('2024-01-15');
          expect(serialized).not.toContain('2023-11-02');
          expect(serialized).not.toContain('identities');
          expect(serialized).not.toContain('Hidden Member');
          expect(serialized).not.toContain('secret');
          expect(serialized).not.toContain('user_metadata');
          expect(serialized).not.toContain('do-not-leak');
        });
    });

    it('maps an explicit already-registered error to a 409 Conflict', async () => {
      authApi.signUp.mockResolvedValue({
        data: { user: null, session: null },
        error: authApiError('User already registered', 400),
      });

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send(registerCredentials)
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 409,
            message: 'An account with this email already exists.',
            error: 'Conflict',
          });
        });
    });

    it('returns 400 for an invalid email/password payload without calling Supabase', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: 'not-an-email',
          password: 'short',
          fullName: 'Ada Lovelace',
        })
        .expect(400);

      expect(authApi.signUp).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only fullName without calling Supabase', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ ...registerCredentials, fullName: '     ' })
        .expect(400);

      expect(authApi.signUp).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/login', () => {
    it('signs in and returns a user + session (200)', async () => {
      authApi.signInWithPassword.mockResolvedValue({
        data: { user: userA, session },
        error: null,
      });

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send(credentials)
        .expect(200)
        .expect(({ body }) => {
          expect(authApi.signInWithPassword).toHaveBeenCalledWith(credentials);
          expect(body.user).toEqual(safeUserA);
          expect(body.session.accessToken).toBe('access-token-value');
        });
    });

    it('maps invalid credentials to a 401 Unauthorized', async () => {
      authApi.signInWithPassword.mockResolvedValue({
        data: { user: null, session: null },
        error: authApiError('Invalid login credentials', 400),
      });

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send(credentials)
        .expect(401)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 401,
            message: 'Email or password is incorrect.',
            error: 'Unauthorized',
          });
        });
    });

    it('does not accept a fullName on login (email/password only)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ ...credentials, fullName: 'Ada Lovelace' })
        .expect(400);

      expect(authApi.signInWithPassword).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 when the Authorization header is missing', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .expect(401)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 401,
            message: 'Missing authorization header.',
            error: 'Unauthorized',
          });
        });
    });

    it('returns 401 for a malformed Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401)
        .expect(({ body }) => {
          expect(body).toHaveProperty(
            'message',
            'Invalid authorization header format.',
          );
        });
    });

    it('returns the verified user for a valid bearer token (200)', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(authApi.getUser).toHaveBeenCalledWith('token-a');
          expect(body.user).toEqual(safeUserA);
          expect(body).toEqual({ user: safeUserA });
        });
    });

    it('returns 401 for an invalid or expired token', async () => {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer unknown-token')
        .expect(401)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 401,
            message: 'Invalid or expired access token.',
            error: 'Unauthorized',
          });
        });
    });
  });

  it('isolates concurrent authenticated requests (no cross-request leakage)', async () => {
    const getMe = (token: string) =>
      request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .then(({ body }) => body.user);

    const [userForA, userForB] = await Promise.all([
      getMe('token-a'),
      getMe('token-b'),
    ]);

    expect(userForA).toEqual(safeUserA);
    expect(userForB).toEqual(safeUserB);
  });
});
