import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { MarketService } from './../src/market/market.service';
import { SupabaseService } from './../src/supabase/supabase.service';

/**
 * Portfolio endpoints end-to-end. SupabaseService and MarketService are both
 * overridden with mocks, so the suite never talks to the live Supabase project
 * or Finnhub. The guard verifies tokens via mocked `auth.getUser`, each PostgREST
 * query resolves a scripted `{ data, error }` FIFO, and quotes come from a mocked
 * `MarketService.getQuotes`. Tests prove the real HTTP contracts (routes, status
 * codes, response bodies) plus that user ownership comes from the token.
 *
 * The mocked 404s verify the API's *neutral* contract only — they are NOT proof
 * that live Supabase Row Level Security works. Real ownership isolation is
 * exercised manually later with two real authenticated users.
 */

const USER = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Ada Lovelace' },
};

const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const HOLDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const portfolioRow = {
  id: PORTFOLIO_ID,
  user_id: USER.id,
  name: 'Tech Holdings',
  created_at: '2026-09-04T10:00:00.000Z',
  updated_at: '2026-09-04T10:00:00.000Z',
};

const holdingRow = {
  id: HOLDING_ID,
  portfolio_id: PORTFOLIO_ID,
  symbol: 'AAPL',
  // PostgREST serializes numeric(18,6) cells as JSON numbers; the API echoes
  // them back as exact decimal strings.
  quantity: 12.5,
  average_purchase_price: 152.3755,
  created_at: '2026-09-04T11:00:00.000Z',
  updated_at: '2026-09-04T11:00:00.000Z',
};

const holdingBody = {
  id: HOLDING_ID,
  symbol: 'AAPL',
  quantity: '12.5',
  averagePurchasePrice: '152.3755',
  createdAt: '2026-09-04T11:00:00.000Z',
  updatedAt: '2026-09-04T11:00:00.000Z',
};

const portfolioBody = {
  id: PORTFOLIO_ID,
  name: 'Tech Holdings',
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
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

describe('Portfolios (e2e)', () => {
  let app: INestApplication<App>;
  let supabaseMock: {
    client: Record<string, never>;
    createAuthClient: jest.Mock;
    createUserClient: jest.Mock;
  };
  let marketMock: { getQuotes: jest.Mock };
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

    marketMock = {
      getQuotes: jest.fn().mockResolvedValue([
        { symbol: 'AAPL', price: 182.7465, change: 0, changePercent: 0, timestamp: '0' },
      ]),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabaseMock)
      .overrideProvider(MarketService)
      .useValue(marketMock)
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

  describe('POST /api/portfolios', () => {
    it('creates a portfolio owned by the authenticated user (201)', async () => {
      pushResult({ data: portfolioRow, error: null });

      await request(app.getHttpServer())
        .post('/api/portfolios')
        .set('Authorization', 'Bearer token-a')
        .send({ name: '  Tech Holdings  ' })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual(portfolioBody);
        });

      expect(supabaseMock.createUserClient).toHaveBeenCalledWith('token-a');
      const insert = calls.find((c) => c.method === 'insert');
      // user_id comes from the verified token, never the request body; the
      // response body asserted above exposes no user_id.
      expect(insert?.args[0]).toEqual({
        user_id: USER.id,
        name: 'Tech Holdings',
      });
    });

    it('returns 409 for a duplicate portfolio name', async () => {
      pushResult({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      });

      await request(app.getHttpServer())
        .post('/api/portfolios')
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Tech Holdings' })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 409,
            message: 'A portfolio with this name already exists.',
            error: 'Conflict',
          });
        });
    });

    it('rejects a whitespace-only name with 400 before any query', async () => {
      await request(app.getHttpServer())
        .post('/api/portfolios')
        .set('Authorization', 'Bearer token-a')
        .send({ name: '     ' })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/portfolios', () => {
    it('returns the user’s portfolios (200) without fetching holdings', async () => {
      pushResult({ data: [portfolioRow], error: null });

      await request(app.getHttpServer())
        .get('/api/portfolios')
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ portfolios: [portfolioBody] });
        });

      const tableCalls = calls.filter((c) => c.table === 'holdings');
      expect(tableCalls).toHaveLength(0);
    });

    it('returns { portfolios: [] } when the user has none', async () => {
      pushResult({ data: [], error: null });

      await request(app.getHttpServer())
        .get('/api/portfolios')
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ portfolios: [] });
        });
    });
  });

  describe('GET /api/portfolios/:id', () => {
    it('returns the portfolio with holdings as exact decimal strings (200)', async () => {
      pushResult({ data: portfolioRow, error: null });
      pushResult({ data: [holdingRow], error: null });

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ ...portfolioBody, holdings: [holdingBody] });
        });

      // Scoped to the caller: the holdings query is filtered to this portfolio.
      expect(
        calls.some(
          (c) =>
            c.table === 'holdings' &&
            c.method === 'eq' &&
            c.args[0] === 'portfolio_id' &&
            c.args[1] === PORTFOLIO_ID,
        ),
      ).toBe(true);
    });

    it('returns 404 for a portfolio that is missing or RLS-hidden', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(404)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 404,
            message: 'Portfolio not found.',
            error: 'Not Found',
          });
        });
    });
  });

  describe('PATCH /api/portfolios/:id', () => {
    it('renames a portfolio the user owns (200)', async () => {
      pushResult({ data: { ...portfolioRow, name: 'Growth Holdings' }, error: null });

      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: '  Growth Holdings  ' })
        .expect(200)
        .expect(({ body }) => {
          expect(body.name).toBe('Growth Holdings');
        });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ name: 'Growth Holdings' });
      expect(
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER.id,
        ),
      ).toBe(true);
    });

    it('returns 404 for a portfolio that is missing or RLS-hidden', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Growth Holdings' })
        .expect(404);
    });

    it('returns 409 when renaming onto an existing name', async () => {
      pushResult({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });

      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Tech Holdings' })
        .expect(409);
    });

    it('rejects a malformed id with 400', async () => {
      await request(app.getHttpServer())
        .patch('/api/portfolios/not-a-uuid')
        .set('Authorization', 'Bearer token-a')
        .send({ name: 'Growth' })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/portfolios/:id', () => {
    it('deletes a portfolio the user owns (204, no body)', async () => {
      pushResult({ data: portfolioRow, error: null });

      const res = await request(app.getHttpServer())
        .delete(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(204);

      expect(res.text).toBe('');
      expect(calls.some((c) => c.method === 'delete')).toBe(true);
    });

    it('returns 404 when nothing was deleted (missing or RLS-hidden)', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .delete(`/api/portfolios/${PORTFOLIO_ID}`)
        .set('Authorization', 'Bearer token-a')
        .expect(404);
    });
  });

  describe('POST /api/portfolios/:id/holdings', () => {
    it('adds a holding, sending canonical decimal strings (201)', async () => {
      pushResult({ data: holdingRow, error: null });

      await request(app.getHttpServer())
        .post(`/api/portfolios/${PORTFOLIO_ID}/holdings`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: '  aapl  ', quantity: 12.5, averagePurchasePrice: 152.3755 })
        .expect(201)
        .expect(({ body }) => {
          expect(body).toEqual(holdingBody);
        });

      const insert = calls.find((c) => c.method === 'insert');
      // Numbers are canonicalized to exact decimal strings before Supabase.
      expect(insert?.args[0]).toEqual({
        portfolio_id: PORTFOLIO_ID,
        symbol: 'AAPL',
        quantity: '12.5',
        average_purchase_price: '152.3755',
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
        .post(`/api/portfolios/${PORTFOLIO_ID}/holdings`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 'AAPL', quantity: 1, averagePurchasePrice: 10 })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 409,
            message: 'This symbol is already held in the portfolio.',
            error: 'Conflict',
          });
        });
    });

    it('returns 404 when the portfolio is missing or inaccessible (FK)', async () => {
      pushResult({
        data: null,
        error: { code: '23503', message: 'foreign key violation' },
      });

      await request(app.getHttpServer())
        .post(`/api/portfolios/${PORTFOLIO_ID}/holdings`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 'AAPL', quantity: 1, averagePurchasePrice: 10 })
        .expect(404);
    });

    it('rejects a non-string symbol with 400', async () => {
      await request(app.getHttpServer())
        .post(`/api/portfolios/${PORTFOLIO_ID}/holdings`)
        .set('Authorization', 'Bearer token-a')
        .send({ symbol: 123, quantity: 1, averagePurchasePrice: 10 })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('rejects zero and over-six-decimal values with 400', async () => {
      for (const body of [
        { symbol: 'AAPL', quantity: 0, averagePurchasePrice: 10 },
        { symbol: 'AAPL', quantity: 1, averagePurchasePrice: 10.1234567 },
        { symbol: 'AAPL', quantity: -1, averagePurchasePrice: 10 },
      ]) {
        await request(app.getHttpServer())
          .post(`/api/portfolios/${PORTFOLIO_ID}/holdings`)
          .set('Authorization', 'Bearer token-a')
          .send(body)
          .expect(400);
      }
      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/portfolios/:id/holdings/:symbol', () => {
    it('updates only the quantity, sending a canonical string (200)', async () => {
      pushResult({
        data: { ...holdingRow, quantity: 15 },
        error: null,
      });

      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}/holdings/aapl`)
        .set('Authorization', 'Bearer token-a')
        .send({ quantity: 15 })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ ...holdingBody, quantity: '15' });
        });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ quantity: '15' });
      // The path symbol is normalized before hitting the database.
      expect(
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'symbol' && c.args[1] === 'AAPL',
        ),
      ).toBe(true);
    });

    it('rejects an empty patch body with 400 before any query', async () => {
      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}/holdings/AAPL`)
        .set('Authorization', 'Bearer token-a')
        .send({})
        .expect(400)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 400,
            message: 'Provide at least one of quantity or averagePurchasePrice.',
            error: 'Bad Request',
          });
        });

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('does NOT treat null as absent — quantity null is a 400', async () => {
      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}/holdings/AAPL`)
        .set('Authorization', 'Bearer token-a')
        .send({ quantity: null })
        .expect(400);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('returns 404 when the holding is missing or RLS-hidden', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .patch(`/api/portfolios/${PORTFOLIO_ID}/holdings/AAPL`)
        .set('Authorization', 'Bearer token-a')
        .send({ quantity: 15 })
        .expect(404);
    });
  });

  describe('DELETE /api/portfolios/:id/holdings/:symbol', () => {
    it('removes a holding (204, no body)', async () => {
      pushResult({ data: holdingRow, error: null });

      const res = await request(app.getHttpServer())
        .delete(`/api/portfolios/${PORTFOLIO_ID}/holdings/aapl`)
        .set('Authorization', 'Bearer token-a')
        .expect(204);

      expect(res.text).toBe('');
      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'symbol' && c.args[1] === 'AAPL',
        ),
      ).toBe(true);
    });

    it('returns 404 when the holding is missing or inaccessible', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .delete(`/api/portfolios/${PORTFOLIO_ID}/holdings/AAPL`)
        .set('Authorization', 'Bearer token-a')
        .expect(404);
    });
  });

  describe('GET /api/portfolios/:id/valuation', () => {
    it('values a holding from the exact quote and returns string decimals (200)', async () => {
      pushResult({ data: { id: PORTFOLIO_ID }, error: null });
      pushResult({
        data: [{ symbol: 'AAPL', quantity: 12.5, average_purchase_price: 152.3755 }],
        error: null,
      });
      marketMock.getQuotes.mockResolvedValue([
        { symbol: 'AAPL', price: 182.7465, change: 0, changePercent: 0, timestamp: '0' },
      ]);

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}/valuation`)
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({
            portfolioId: PORTFOLIO_ID,
            totalInvestedValue: '1904.69',
            totalCurrentValue: '2284.33',
            totalProfitLoss: '379.64',
            totalReturnPercentage: '19.93',
            holdings: [
              {
                symbol: 'AAPL',
                quantity: '12.5',
                averagePurchasePrice: '152.3755',
                // The exact provider price, serialized canonically — not forced
                // to cents — so 12.5 × "182.7465" reproduces "2284.33".
                currentPrice: '182.7465',
                investedValue: '1904.69',
                currentValue: '2284.33',
                profitLoss: '379.64',
                returnPercentage: '19.93',
              },
            ],
          });
        });

      expect(marketMock.getQuotes).toHaveBeenCalledWith(['AAPL']);
      expect(supabaseMock.createUserClient).toHaveBeenCalledWith('token-a');
      // Valuation is read-only: no database writes.
      expect(
        calls.some(
          (c) =>
            c.method === 'insert' || c.method === 'update' || c.method === 'delete',
        ),
      ).toBe(false);
    });

    it('returns zero totals for an empty portfolio and makes NO market calls', async () => {
      pushResult({ data: { id: PORTFOLIO_ID }, error: null });
      pushResult({ data: [], error: null });

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}/valuation`)
        .set('Authorization', 'Bearer token-a')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({
            portfolioId: PORTFOLIO_ID,
            totalInvestedValue: '0.00',
            totalCurrentValue: '0.00',
            totalProfitLoss: '0.00',
            totalReturnPercentage: '0.00',
            holdings: [],
          });
        });

      expect(marketMock.getQuotes).not.toHaveBeenCalled();
    });

    it('returns 422 when a held symbol has no market data', async () => {
      pushResult({ data: { id: PORTFOLIO_ID }, error: null });
      pushResult({
        data: [{ symbol: 'ZZZZ', quantity: 1, average_purchase_price: 10 }],
        error: null,
      });
      marketMock.getQuotes.mockRejectedValue(new NotFoundException('Unknown symbol "ZZZZ"'));

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}/valuation`)
        .set('Authorization', 'Bearer token-a')
        .expect(422)
        .expect(({ body }) => {
          expect(body.statusCode).toBe(422);
          expect(body.message).toContain('ZZZZ');
        });
    });

    it('returns 404 for a portfolio that is missing or RLS-hidden', async () => {
      pushResult({ data: null, error: null });

      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}/valuation`)
        .set('Authorization', 'Bearer token-a')
        .expect(404);
    });
  });

  describe('authentication', () => {
    it('returns 401 for a missing Authorization header on every route', async () => {
      await request(app.getHttpServer()).get('/api/portfolios').expect(401);
      await request(app.getHttpServer())
        .post('/api/portfolios')
        .send({ name: 'X' })
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/portfolios/${PORTFOLIO_ID}/valuation`)
        .expect(401);

      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('returns 401 for an invalid bearer token without touching the database', async () => {
      await request(app.getHttpServer())
        .get('/api/portfolios')
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
