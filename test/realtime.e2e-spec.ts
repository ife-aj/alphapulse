import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { MarketService } from './../src/market/market.service';
import { SupabaseService } from './../src/supabase/supabase.service';
import {
  PORTFOLIO_SUBSCRIBE_EVENT,
  PORTFOLIO_UNSUBSCRIBE_EVENT,
  PORTFOLIO_VALUATION_EVENT,
  type PortfolioSubscribeAck,
  type PortfolioUnsubscribeAck,
  type PortfolioValuationEvent,
} from './../src/realtime/realtime.types';

/**
 * Realtime portfolio socket end-to-end, over real Socket.IO clients and a real
 * socket.io server attached to the app's HTTP listener on an ephemeral port.
 *
 * The gateway shares the bootstrapped AppModule with the REST API, so the same
 * overridden SupabaseService and MarketService mocks script auth (`auth.getUser`
 * by token), PostgREST reads (a `{ data, error }` FIFO per query) and quotes.
 *
 * This suite proves the wire contract: who can connect, the four events, the
 * acknowledgement shapes, the exact-decimal valuation event, idempotent
 * subscribe/unsubscribe, and independent per-socket subscriptions. Like the
 * HTTP e2e, the scripted 404 verifies the API's neutral ownership contract only
 * — real RLS isolation is exercised later with two live users.
 */

const USER = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Ada Lovelace' },
};

// A second, distinct, authenticated user who owns nothing.
const USER_B = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  email: 'other@example.com',
  email_confirmed_at: '2026-09-03T10:00:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { full_name: 'Grace Hopper' },
};

const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const PORTFOLIO_ROW = { id: PORTFOLIO_ID, user_id: USER.id };
// PostgREST serializes numeric(18,6) cells as JSON numbers.
const HOLDINGS_ROW = [
  { symbol: 'AAPL', quantity: 12.5, average_purchase_price: 152.3755 },
];

const VALUATION_EVENT_BODY = {
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
      // The exact provider price, serialized canonically (never rounded).
      currentPrice: '182.7465',
      investedValue: '1904.69',
      currentValue: '2284.33',
      profitLoss: '379.64',
      returnPercentage: '19.93',
    },
  ],
};

type Result = { data: unknown; error: unknown };
type ChainCall = { table: string; method: string; args: unknown[] };

function makeChain(
  resultAccessor: () => Result,
  calls: ChainCall[],
  table: string,
) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'order']) {
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

describe('Realtime portfolio socket (e2e)', () => {
  let app: INestApplication<App>;
  let port: number;
  let supabaseMock: {
    client: Record<string, never>;
    createAuthClient: jest.Mock;
    createUserClient: jest.Mock;
  };
  let authApi: { getUser: jest.Mock };
  /** Scripted PostgREST results, consumed FIFO per resolved query. */
  let postgrestResults: Result[];
  const calls: ChainCall[] = [];
  const clients: Socket[] = [];

  function pushResult(result: Result): void {
    postgrestResults.push(result);
  }

  /** Script the two reads (portfolio existence + holdings) one valuation makes. */
  function pushOwnedPortfolio(): void {
    pushResult({ data: PORTFOLIO_ROW, error: null });
    pushResult({ data: HOLDINGS_ROW, error: null });
  }

  /** Connect a real socket.io client; rejects with the connect_error on failure. */
  function connect(token?: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...(token === undefined ? {} : { auth: { token } }),
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (error) => reject(error));
    });
  }

  function subscribe(
    socket: Socket,
    portfolioId: string,
  ): Promise<PortfolioSubscribeAck> {
    return new Promise((resolve) => {
      socket.emit(
        PORTFOLIO_SUBSCRIBE_EVENT,
        { portfolioId },
        (ack: PortfolioSubscribeAck) => resolve(ack),
      );
    });
  }

  function unsubscribe(
    socket: Socket,
    portfolioId: string,
  ): Promise<PortfolioUnsubscribeAck> {
    return new Promise((resolve) => {
      socket.emit(
        PORTFOLIO_UNSUBSCRIBE_EVENT,
        { portfolioId },
        (ack: PortfolioUnsubscribeAck) => resolve(ack),
      );
    });
  }

  function waitForValuation(socket: Socket): Promise<PortfolioValuationEvent> {
    return new Promise((resolve) => {
      socket.once(PORTFOLIO_VALUATION_EVENT, (payload) => resolve(payload));
    });
  }

  const isAuthFailure = (
    error: unknown,
  ): error is Error & {
    data?: { code: string };
  } => error instanceof Error;

  beforeEach(async () => {
    calls.length = 0;
    postgrestResults = [];

    authApi = {
      getUser: jest.fn().mockImplementation(async (token: string) => {
        if (token === 'token-a') return { data: { user: USER }, error: null };
        if (token === 'token-b') return { data: { user: USER_B }, error: null };
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

    const marketMock = {
      getQuotes: jest.fn().mockResolvedValue([
        {
          symbol: 'AAPL',
          price: 182.7465,
          change: 0,
          changePercent: 0,
          timestamp: '0',
        },
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
    app.useWebSocketAdapter(new IoAdapter(app));
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const socket of clients) socket.disconnect();
    clients.length = 0;
    await app.close();
  });

  describe('connection authentication', () => {
    it('rejects a connection with no access token (connect_error, UNAUTHORIZED)', async () => {
      const failure = await connect().catch((error) => error);
      expect(isAuthFailure(failure)).toBe(true);
      expect(failure!.message).toBe('Authentication failed.');
      expect(failure!.data).toEqual({ code: 'UNAUTHORIZED' });
      expect(authApi.getUser).not.toHaveBeenCalled();
    });

    it('rejects an invalid access token (connect_error, UNAUTHORIZED)', async () => {
      const failure = await connect('not-a-real-token').catch((error) => error);
      expect(isAuthFailure(failure)).toBe(true);
      expect(failure!.message).toBe('Authentication failed.');
      expect(failure!.data).toEqual({ code: 'UNAUTHORIZED' });
      // The database is never reached for an unauthenticated socket.
      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('accepts a valid access token', async () => {
      const socket = await connect('token-a');
      expect(socket.id).toBeTruthy();
    });
  });

  describe('portfolio:subscribe', () => {
    it('rejects a malformed (non-UUID) portfolioId with VALIDATION_ERROR before any query', async () => {
      const socket = await connect('token-a');
      const ack = await subscribe(socket, 'not-a-uuid');
      expect(ack).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('subscribes to an owned portfolio and emits one initial valuation with the exact REST contract', async () => {
      pushOwnedPortfolio();
      const socket = await connect('token-a');

      const valuationPromise = waitForValuation(socket);
      const ack = await subscribe(socket, PORTFOLIO_ID);

      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      expect(supabaseMock.createUserClient).toHaveBeenCalledWith('token-a');
      // Ownership comes from the verified token, never from the payload.
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' &&
            c.args[0] === 'user_id' &&
            c.args[1] === USER.id,
        ),
      ).toBe(true);

      const event = await valuationPromise;
      expect(event.portfolioId).toBe(PORTFOLIO_ID);
      expect(new Date(event.emittedAt).toISOString()).toBe(event.emittedAt);
      // The existing exact-decimal valuation DTO is preserved byte-for-byte.
      expect(event.valuation).toEqual(VALUATION_EVENT_BODY);
    });

    it('does not let one user subscribe to another user’s portfolio', async () => {
      // user-b owns nothing: the RLS-scoped select for their user_id finds no
      // portfolio and the socket gets the same neutral response as a missing one.
      pushResult({ data: null, error: null });
      const socket = await connect('token-b');

      const ack = await subscribe(socket, PORTFOLIO_ID);

      expect(ack).toEqual({
        ok: false,
        error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio not found.' },
      });
      // The lookup was scoped to the *authenticated* user (token-b), never a
      // user id taken from the payload.
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' &&
            c.args[0] === 'user_id' &&
            c.args[1] === USER_B.id,
        ),
      ).toBe(true);
      expect(
        calls.some((c) => c.method === 'eq' && c.args[1] === USER.id),
      ).toBe(false);
    });

    it('is idempotent: a duplicate subscribe succeeds with subscribed:false and does not re-value', async () => {
      pushOwnedPortfolio();
      const socket = await connect('token-a');

      const first = await subscribe(socket, PORTFOLIO_ID);
      expect(first).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });

      // No additional valuation for the duplicate.
      const second = await subscribe(socket, PORTFOLIO_ID);
      expect(second).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      // One ownership/valuation pass only.
      expect(supabaseMock.createUserClient).toHaveBeenCalledTimes(1);
    });

    it('lets two sockets of the same user subscribe to the same portfolio independently', async () => {
      pushOwnedPortfolio();
      const socketA = await connect('token-a');
      // Attach the valuation listener BEFORE subscribing — the valuation packet
      // precedes the ack on the wire, so waiting on it after the ack would miss it.
      const valuationA = waitForValuation(socketA);
      const ackA = await subscribe(socketA, PORTFOLIO_ID);
      expect(ackA).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      // A’s ownership/valuation reads complete before its ack, so the FIFO is
      // drained before B subscribes.
      await expect(valuationA).resolves.toMatchObject({
        portfolioId: PORTFOLIO_ID,
      });

      pushOwnedPortfolio();
      const socketB = await connect('token-a');
      const valuationB = waitForValuation(socketB);
      const ackB = await subscribe(socketB, PORTFOLIO_ID);
      expect(ackB).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      // B is a fresh subscription, not a duplicate of A’s, and gets its own event.
      await expect(valuationB).resolves.toMatchObject({
        valuation: VALUATION_EVENT_BODY,
      });
      // Two independent ownership/valuation passes happened.
      expect(supabaseMock.createUserClient).toHaveBeenCalledTimes(2);
    });
  });

  describe('portfolio:unsubscribe', () => {
    it('removes the subscription: a later resubscribe is a fresh subscribe', async () => {
      pushOwnedPortfolio();
      const socket = await connect('token-a');
      const firstValuation = waitForValuation(socket);
      const first = await subscribe(socket, PORTFOLIO_ID);
      expect(first).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      await firstValuation;

      const unsub = await unsubscribe(socket, PORTFOLIO_ID);
      expect(unsub).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });

      // A resubscribe is no longer a duplicate — the tracked state is gone — so
      // it re-validates and re-values.
      pushOwnedPortfolio();
      const secondValuation = waitForValuation(socket);
      const again = await subscribe(socket, PORTFOLIO_ID);
      expect(again).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      await secondValuation;
      expect(supabaseMock.createUserClient).toHaveBeenCalledTimes(2);
    });

    it('is idempotent: unsubscribing a portfolio that was never subscribed succeeds', async () => {
      const socket = await connect('token-a');
      const first = await unsubscribe(socket, PORTFOLIO_ID);
      expect(first).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
      const second = await unsubscribe(socket, PORTFOLIO_ID);
      expect(second).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
      expect(supabaseMock.createUserClient).not.toHaveBeenCalled();
    });

    it('rejects a malformed portfolioId with VALIDATION_ERROR', async () => {
      const socket = await connect('token-a');
      const ack = await unsubscribe(socket, 'nope');
      expect(ack).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
    });
  });

  describe('disconnect cleanup', () => {
    it('removes all subscriptions when a socket disconnects, leaving later sockets unaffected', async () => {
      pushOwnedPortfolio();
      pushOwnedPortfolio();
      const socketA = await connect('token-a');
      const p1 = await subscribe(socketA, PORTFOLIO_ID);
      const other = '22222222-2222-4222-8222-222222222222';
      const p2 = await subscribe(socketA, other);
      expect(p1).toMatchObject({ ok: true });
      expect(p2).toMatchObject({ ok: true });

      socketA.disconnect();

      // A fresh socket for the same user starts clean: a new subscription is a
      // fresh subscribe and valuation, proving nothing leaked across sockets.
      pushOwnedPortfolio();
      const socketB = await connect('token-a');
      const freshValuation = waitForValuation(socketB);
      const fresh = await subscribe(socketB, PORTFOLIO_ID);
      expect(fresh).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      await expect(freshValuation).resolves.toMatchObject({
        portfolioId: PORTFOLIO_ID,
      });
      expect(supabaseMock.createUserClient).toHaveBeenCalledTimes(3);
    });
  });
});
