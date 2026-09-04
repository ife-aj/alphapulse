import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * Watchlist endpoints end-to-end. SupabaseService is overridden with a mock, so
 * the suite never talks to the live Supabase project. The guard verifies tokens
 * via mocked `auth.getUser`, and each PostgREST query resolves a scripted
 * `{ data, error }` FIFO, so the tests prove the real HTTP contracts (routes,
 * status codes, response bodies) plus that user ownership comes from the token.
 */

const USER = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Ada Lovelace' },
};

const WATCHLIST_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const watchlistRow = {
  id: WATCHLIST_ID,
  user_id: USER.id,
  name: 'Tech Stocks',
  created_at: '2026-09-04T10:00:00.000Z',
  updated_at: '2026-09-04T10:00:00.000Z',
};

const itemRow = {
  id: ITEM_ID,
  watchlist_id: WATCHLIST_ID,
  symbol: 'AAPL',
  created_at: '2026-09-04T11:00:00.000Z',
  updated_at: '2026-09-04T11:00:00.000Z',
};

type Result = { data: unknown; error: unknown };
type ChainCall = { table: string; method: string; args: unknown[] };

function makeChain(
  resultAccessor: () => Result,
  calls: ChainCall[],
  table: string,
) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'order',
    'eq',
    'in',
  ]) {
    chain[method] = jest.fn((...args: unknown[]) => {
      calls.push({ table, method, args });
      return chain;
    });
  }
  chain.single = jest.fn(() => Promise.resolve(resultAccessor()));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resultAccessor()));
  chain.then = (resolve: (v: Result) => void) => resolve(resultAccessor());
  return chain;
}

const authApiError = (message: string, status: number) => ({
  message,
  status,
  name: 'AuthApiError',
  __isAuthError: true,
});

describe('Watchlists (e2e)', () => {
  let app: INestApplication<App>;
  let supabaseMock: {
    client: Record<string, never>;
    createAuthClient: jest.Mock;
    createUserClient: jest.Mock;
  };
  let authApi: { getUser: jest.Mock };
  /** Scripted PostgREST results, consumed FIFO per resolved query. */
  let postgrestResults: Result[];
  const calls: ChainCall[] = [];

  function pushResult(result: Result): void {
    postgrestResults.push(result);
  }

  beforeEach(async () => {
    calls.length = 0;
    postgrestResults = [];

    authApi = {
      getUser: jest.fn().mockImplementation(async (token: string) => {
        if (token === 'token-a') return { data: { user: USER }, error: null };
        return {
          data: { user: null },
          error: authApiError('JWT invalid', 401),
        };
      }),
    };

    supabaseMock = {
      client: {},
      createAuthClient: jest.fn().mockReturnValue({ auth: authApi }),
      createUserClient: jest.fn().mockReturnValue({
        from: jest.fn((table: string) =>
          makeChain(
            () =>
              postgrestResults.shift() ?? {
                data: null,
                error: { code: 'UNSET', message: 'no scripted result' },
              },
            calls,
            table,
          ),
        ),
      }),
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

  describe('POST /api/watchlists', () => {
    it('creates a watchlist owned by the authenticated user (201)', async () => {
      pushResult({ data: watchlistRow, error: null });

      await request(app.getHttpServer())
        .post('/api/watchlists')
        .set('Authorization', 'Bearer token-a')
        .send({ name: '  Tech Stocks  ' })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual({
            id: WATCHLIST_ID,
            name: 'Tech Stocks',
            createdAt: '2026-09-04T10:00:00.000Z',
            updatedAt: '2026-09-04T10:00:00.000Z',
          });
        });

      expect(supabaseMock.createUserClient).toHaveBeenCalledWith('token-a');
      const insert = calls.find((c) => c.method === 'insert');
      // user_id comes from the verified token, never the request body.
      expect(insert?.args[0]).toEqual({
        user_id: USER.id,
        name: 'Tech Stocks',
      });
      // The response body (asserted above) exposes no user_id or wire fields.
    });

    it('returns 409 for a duplicate watchlist name', async () => {
      pushResult({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      });

      await request(app.getHttpServer())
        .post('/api/watchlists')
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Tech Stocks' })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 409,
            message: 'A watchlist with this name already exists.',
            error: 'Conflict',
          });
        });
    });

    it('rejects a whitespace-only name with 400 before any query', async () => {
      await request(app.getHttpServer())
        .post('/api/watchlists')
        .set('Authorization', 'Bearer token-a')
        .send({ name: '     ' })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/watchlists', () => {
    it('returns the user’s watchlists with their items, ordered (200)', async () => {
      pushResult({ data: [watchlistRow], error: null });
      pushResult({ data: [itemRow], error: null });

      await request(app.getHttpServer())
        .get('/api/watchlists')
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({
            watchlists: [
              {
                id: WATCHLIST_ID,
                name: 'Tech Stocks',
                createdAt: '2026-09-04T10:00:00.000Z',
                updatedAt: '2026-09-04T10:00:00.000Z',
                items: [
                  {
                    id: ITEM_ID,
                    symbol: 'AAPL',
                    createdAt: '2026-09-04T11:00:00.000Z',
                    updatedAt: '2026-09-04T11:00:00.000Z',
                  },
                ],
              },
            ],
          });
        });

      // The items query is scoped to the fetched watchlist ids.
      const inCall = calls.find((c) => c.method === 'in');
      expect(inCall?.args).toEqual(['watchlist_id', [WATCHLIST_ID]]);
    });

    it('returns { watchlists: [] } when the user has no watchlists', async () => {
      pushResult({ data: [], error: null });

      await request(app.getHttpServer())
        .get('/api/watchlists')
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ watchlists: [] });
        });

      // No watchlist_items.in('watchlist_id', []) with an empty array.
      expect(calls.some((c) => c.method === 'in')).toBe(false);
    });
  });

  describe('PATCH /api/watchlists/:id', () => {
    it('renames a watchlist the user owns (200)', async () => {
      pushResult({
        data: { ...watchlistRow, name: 'Growth Stocks' },
        error: null,
      });

      await request(app.getHttpServer())
        .patch(`/api/watchlists/${WATCHLIST_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: '  Growth Stocks  ' })
        .expect(200)
        .expect(({ body }) => {
          expect(body.name).toBe('Growth Stocks');
        });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ name: 'Growth Stocks' });
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' &&
            c.args[0] === 'user_id' &&
            c.args[1] === USER.id,
        ),
      ).toBe(true);
    });

    it('returns 404 for a watchlist that is missing or RLS-hidden', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .patch(`/api/watchlists/${WATCHLIST_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Growth Stocks' })
        .expect(404)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 404,
            message: 'Watchlist not found.',
            error: 'Not Found',
          });
        });
    });

    it('returns 409 when renaming onto an existing name', async () => {
      pushResult({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });

      await request(app.getHttpServer())
        .patch(`/api/watchlists/${WATCHLIST_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Tech Stocks' })
        .expect(409);
    });

    it('rejects a malformed id with 400', async () => {
      await request(app.getHttpServer())
        .patch('/api/watchlists/not-a-uuid')
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Growth' })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/watchlists/:id', () => {
    it('deletes a watchlist the user owns (204, no body)', async () => {
      pushResult({ data: watchlistRow, error: null });

      const res = await request(app.getHttpServer())
        .delete(`/api/watchlists/${WATCHLIST_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(204);

      expect(res.text).toBe('');
      expect(calls.some((c) => c.method === 'delete')).toBe(true);
    });

    it('returns 404 when nothing was deleted (missing or RLS-hidden)', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .delete(`/api/watchlists/${WATCHLIST_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(404);
    });
  });

  describe('POST /api/watchlists/:id/items', () => {
    it('adds a normalized symbol to the watchlist (201)', async () => {
      pushResult({ data: itemRow, error: null });

      await request(app.getHttpServer())
        .post(`/api/watchlists/${WATCHLIST_ID}/items`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: '  aapl  ' })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual({
            id: ITEM_ID,
            symbol: 'AAPL',
            createdAt: '2026-09-04T11:00:00.000Z',
            updatedAt: '2026-09-04T11:00:00.000Z',
          });
        });

      const insert = calls.find((c) => c.method === 'insert');
      expect(insert?.args[0]).toEqual({
        watchlist_id: WATCHLIST_ID,
        symbol: 'AAPL',
      });
    });

    it('returns 409 for a duplicate symbol', async () => {
      pushResult({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      });

      await request(app.getHttpServer())
        .post(`/api/watchlists/${WATCHLIST_ID}/items`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 'AAPL' })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 409,
            message: 'This symbol is already in the watchlist.',
            error: 'Conflict',
          });
        });
    });

    it('returns 404 when the watchlist is missing or inaccessible', async () => {
      pushResult({
        data: null,
        error: { code: '23503', message: 'foreign key violation' },
      });

      await request(app.getHttpServer())
        .post(`/api/watchlists/${WATCHLIST_ID}/items`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 'AAPL' })
        .expect(404);
    });

    it('rejects an invalid symbol with 400', async () => {
      await request(app.getHttpServer())
        .post(`/api/watchlists/${WATCHLIST_ID}/items`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 'BRK/B' })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/watchlists/:id/items/:symbol', () => {
    it('removes a symbol from the watchlist (204, no body)', async () => {
      pushResult({ data: itemRow, error: null });

      const res = await request(app.getHttpServer())
        .delete(`/api/watchlists/${WATCHLIST_ID}/items/aapl`)
        .set('Authorization', 'Bearer token-a')
        .expect(204);

      expect(res.text).toBe('');
      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' && c.args[0] === 'symbol' && c.args[1] === 'AAPL',
        ),
      ).toBe(true);
    });

    it('returns 404 when the item is missing or inaccessible', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .delete(`/api/watchlists/${WATCHLIST_ID}/items/AAPL`)
        .set('Authorization', 'Bearer token-a')
        .expect(404);
    });
  });

  describe('authentication', () => {
    it('returns 401 for a missing Authorization header on every route', async () => {
      await request(app.getHttpServer()).get('/api/watchlists').expect(401);
      await request(app.getHttpServer())
        .post('/api/watchlists')
        .send({ name: 'X' })
        .expect(401);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('returns 401 for an invalid bearer token without touching the database', async () => {
      await request(app.getHttpServer())
        .get('/api/watchlists')
        .set('Authorization', 'Bearer unknown-token')
        .expect(401)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 401,
            message: 'Invalid or expired access token.',
            error: 'Unauthorized',
          });
        });

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });
});
