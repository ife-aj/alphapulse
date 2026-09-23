import {
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Decimal from 'decimal.js';
import { SupabaseService } from '../supabase/supabase.service';
import { InternalHoldingsService } from './internal-holdings.service';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosModule } from './portfolios.module';

/**
 * Trusted internal holdings reader, over the real `InternalHoldingsService` with
 * a scripted PostgREST chain and a mocked `createClient`.
 *
 * Most of these tests exist because this path bypasses Row Level Security: the
 * ownership `WHERE` clause is the *only* thing standing between a caller and
 * another tenant's data, so the query it builds is asserted directly rather than
 * inferred from behaviour.
 */

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const mockedCreateClient = createClient as unknown as jest.Mock;

const URL = 'https://abcdefghijk.supabase.co';
// A structurally-realistic (but fake) service-role JWT. Never a real credential.
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.dummy-signature';
const SERVER_AUTH_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
};

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';

/** Scripted PostgREST response. */
type Result = { data: unknown; error: unknown };

/** One captured chain call (`{ method: 'eq', args: ['user_id', …] }`). */
interface ChainCall {
  method: string;
  args: unknown[];
}

/** A query chain for one table, recording every builder/terminal call. */
interface QueryChain {
  table: string;
  calls: ChainCall[];
}

function buildChain(result: () => Result | undefined, calls: ChainCall[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'order']) {
    chain[method] = jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.maybeSingle = jest.fn(() => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(result());
  });
  // Makes the chain awaitable, so the holdings read resolves like a real thenable.
  chain.then = (resolve: (value: Result | undefined) => void) => {
    calls.push({ method: 'then', args: [] });
    resolve(result());
  };
  return chain;
}

/**
 * A Supabase client double whose `from()` records the table it was asked for and
 * hands back the corresponding scripted result, in call order. Every query the
 * service issues consumes the next scripted result.
 */
function buildClient(results: Result[]) {
  const chains: QueryChain[] = [];
  const from = jest.fn((table: string) => {
    const calls: ChainCall[] = [];
    chains.push({ table, calls });
    return buildChain(() => results[chains.length - 1], calls);
  });
  return { from, chains };
}

function configFrom(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key in values) return values[key];
      throw new Error(`Configuration key "${key}" is missing`);
    },
  } as unknown as ConfigService;
}

const FULL_CONFIG: Record<string, string> = {
  SUPABASE_URL: URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
};

/** Build the service over a scripted client and capture its recorded queries. */
function makeService(results: Result[], config = FULL_CONFIG) {
  const { from, chains } = buildClient(results);
  mockedCreateClient.mockReturnValue({ from } as unknown as SupabaseClient);
  return {
    service: new InternalHoldingsService(configFrom(config)),
    from,
    chains,
  };
}

/** The `eq` calls made against a captured query chain, in order. */
function eqCalls(chain: QueryChain): ChainCall[] {
  return chain.calls.filter((call) => call.method === 'eq');
}

/** An owned portfolio: the portfolios lookup succeeds. */
function ownedPortfolio(): Result {
  return { data: { id: PORTFOLIO_ID }, error: null };
}

/** No such portfolio — or one belonging to somebody else. Indistinguishable. */
function noPortfolio(): Result {
  return { data: null, error: null };
}

function holdingsRows(rows: unknown[]): Result {
  return { data: rows, error: null };
}

const AAPL_ROW = {
  symbol: 'AAPL',
  quantity: 12.5,
  average_purchase_price: 152.3755,
};

/** Run one call and return whatever it threw. */
async function captureError(
  results: Result[],
  userId: string = USER_ID,
): Promise<Error> {
  const { service } = makeService(results);
  try {
    await service.getInternalValuationHoldings(userId, PORTFOLIO_ID);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

/** The observable identity of a thrown error, for indistinguishability checks. */
function shape(error: Error): { name: string; message: string } {
  return { name: error.constructor.name, message: error.message };
}

describe('InternalHoldingsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('owned portfolio', () => {
    it('returns exact Decimal holdings', async () => {
      const { service } = makeService([
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
      ]);

      const holdings = await service.getInternalValuationHoldings(
        USER_ID,
        PORTFOLIO_ID,
      );

      expect(holdings).toHaveLength(1);
      expect(holdings[0].symbol).toBe('AAPL');
      expect(holdings[0].quantity).toBeInstanceOf(Decimal);
      expect(holdings[0].quantity.toString()).toBe('12.5');
      expect(holdings[0].averagePurchasePrice).toBeInstanceOf(Decimal);
      expect(holdings[0].averagePurchasePrice.toString()).toBe('152.3755');
    });

    it('constrains ownership by both portfolio id and user id', async () => {
      const { service, chains } = makeService([
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
      ]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      // The privileged client bypasses RLS, so this exact clause is the entire
      // authorization boundary: both constraints must be present, in this chain.
      expect(chains[0].table).toBe('portfolios');
      expect(eqCalls(chains[0])).toEqual([
        { method: 'eq', args: ['id', PORTFOLIO_ID] },
        { method: 'eq', args: ['user_id', USER_ID] },
      ]);
    });

    it('selects only the portfolio id and uses maybeSingle', async () => {
      const { service, chains } = makeService([
        ownedPortfolio(),
        holdingsRows([]),
      ]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(chains[0].calls).toContainEqual({
        method: 'select',
        args: ['id'],
      });
      expect(chains[0].calls).toContainEqual({
        method: 'maybeSingle',
        args: [],
      });
    });

    it('returns an empty array for an owned portfolio with no holdings', async () => {
      const { service, chains } = makeService([
        ownedPortfolio(),
        holdingsRows([]),
      ]);

      const holdings = await service.getInternalValuationHoldings(
        USER_ID,
        PORTFOLIO_ID,
      );

      expect(holdings).toEqual([]);
      // An empty portfolio is a successful read, not a missing one.
      expect(chains[1].table).toBe('holdings');
    });

    it('preserves exact values from numeric strings as well as numbers', async () => {
      const { service } = makeService([
        ownedPortfolio(),
        holdingsRows([
          {
            symbol: 'BRK.B',
            quantity: '0.000001',
            average_purchase_price: '12.500000',
          },
        ]),
      ]);

      const holdings = await service.getInternalValuationHoldings(
        USER_ID,
        PORTFOLIO_ID,
      );

      // Exact, with numeric(18,6) trailing zeros normalized away — no float step.
      expect(holdings[0].quantity.toString()).toBe('0.000001');
      expect(holdings[0].averagePurchasePrice.toString()).toBe('12.5');
    });
  });

  describe('ownership failure', () => {
    it('throws the neutral 404 when the portfolio does not exist', async () => {
      const error = await captureError([noPortfolio()]);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toBe('Portfolio not found.');
    });

    it('makes a foreign portfolio indistinguishable from a missing one', async () => {
      // On this client another user's portfolio is simply absent, so both cases
      // yield the same `data: null` and the same neutral error.
      const missing = await captureError([noPortfolio()]);
      const foreign = await captureError([noPortfolio()]);

      expect(shape(foreign)).toEqual(shape(missing));
      expect(shape(foreign)).toEqual({
        name: 'NotFoundException',
        message: 'Portfolio not found.',
      });
    });

    it('never reads holdings when ownership was not proven', async () => {
      const { service, from, chains } = makeService([noPortfolio()]);

      await expect(
        service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Exactly one query ran, against portfolios — holdings were never touched.
      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('portfolios');
      expect(chains.map((chain) => chain.table)).toEqual(['portfolios']);
    });

    it('does not fall back to the portfolio id alone when the user id is wrong', async () => {
      const { service, chains } = makeService([noPortfolio()]);

      await expect(
        service.getInternalValuationHoldings(OTHER_USER_ID, PORTFOLIO_ID),
      ).rejects.toBeInstanceOf(NotFoundException);

      // The user id supplied is the one that reached the query — there is no
      // alternate path that would drop it and match on the portfolio id instead.
      expect(eqCalls(chains[0])).toEqual([
        { method: 'eq', args: ['id', PORTFOLIO_ID] },
        { method: 'eq', args: ['user_id', OTHER_USER_ID] },
      ]);
    });
  });

  describe('holdings query shape', () => {
    it('requests only the three fields the valuation needs', async () => {
      const { service, chains } = makeService([
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
      ]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(chains[1].calls).toContainEqual({
        method: 'select',
        args: ['symbol, quantity, average_purchase_price'],
      });
    });

    it('scopes the holdings read by portfolio id and orders by symbol', async () => {
      const { service, chains } = makeService([
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
      ]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(eqCalls(chains[1])).toEqual([
        { method: 'eq', args: ['portfolio_id', PORTFOLIO_ID] },
      ]);
      expect(chains[1].calls).toContainEqual({
        method: 'order',
        args: ['symbol'],
      });
    });
  });

  describe('database error mapping', () => {
    it('maps a portfolio-query failure with the existing conventions', async () => {
      const { service, from, chains } = makeService([
        { data: null, error: { code: 'XX000', message: 'connection reset' } },
      ]);

      const error = await service
        .getInternalValuationHoldings(USER_ID, PORTFOLIO_ID)
        .then(() => null)
        .catch((thrown: Error) => thrown);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      // The raw PostgREST message never reaches the caller.
      expect(error?.message).not.toMatch(/connection reset/);
      // A failed ownership check reads nothing else.
      expect(from).toHaveBeenCalledTimes(1);
      expect(chains.map((chain) => chain.table)).toEqual(['portfolios']);
    });

    it('maps a holdings-query failure with the existing conventions', async () => {
      const error = await captureError([
        ownedPortfolio(),
        { data: null, error: { code: 'XX000', message: 'connection reset' } },
      ]);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).not.toMatch(/connection reset/);
    });

    it('maps an unexpected thrown value rather than leaking it', async () => {
      const { from, chains } = buildClient([]);
      from.mockImplementation(() => {
        throw new Error('boom: internal driver detail');
      });
      mockedCreateClient.mockReturnValue({ from } as unknown as SupabaseClient);
      const service = new InternalHoldingsService(configFrom(FULL_CONFIG));

      const error = await service
        .getInternalValuationHoldings(USER_ID, PORTFOLIO_ID)
        .then(() => null)
        .catch((thrown: Error) => thrown);

      // Classified as an AlphaPulse failure, with no driver detail in the message.
      expect(error).toBeInstanceOf(HttpException);
      expect(error?.message).not.toMatch(/internal driver detail/);
      expect(chains).toEqual([]);
    });
  });

  describe('privileged client lifecycle', () => {
    it('builds the client lazily — not at construction time', async () => {
      const { service } = makeService([ownedPortfolio(), holdingsRows([])]);

      // Constructing the provider performs no credential read and builds nothing.
      expect(mockedCreateClient).not.toHaveBeenCalled();

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    });

    it('creates the client with the service-role key and non-persistent auth', async () => {
      const { service } = makeService([ownedPortfolio(), holdingsRows([])]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(mockedCreateClient).toHaveBeenCalledWith(
        URL,
        SERVICE_ROLE_KEY,
        SERVER_AUTH_OPTIONS,
      );
    });

    it('reuses one client across successful calls', async () => {
      const { service } = makeService([
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
        ownedPortfolio(),
        holdingsRows([AAPL_ROW]),
      ]);

      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);
      await service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);

      expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    });

    it('fails loudly when the service-role key is absent from configuration', async () => {
      const { service } = makeService([ownedPortfolio()], {
        SUPABASE_URL: URL,
      });

      await expect(
        service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID),
      ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    });

    it('never logs the URL or the service-role key', async () => {
      const logSpies = (
        ['log', 'warn', 'error', 'debug', 'verbose'] as const
      ).map((method) =>
        jest
          .spyOn(Logger.prototype, method)
          .mockImplementation(() => undefined),
      );

      try {
        // Exercise a success, an ownership failure, and a database failure.
        await makeService([
          ownedPortfolio(),
          holdingsRows([AAPL_ROW]),
        ]).service.getInternalValuationHoldings(USER_ID, PORTFOLIO_ID);
        await captureError([noPortfolio()]);
        await captureError([
          ownedPortfolio(),
          { data: null, error: { code: 'XX000', message: 'nope' } },
        ]);

        const logged = logSpies
          .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
          .join('\n');

        // The key really was in play, so the assertions below are not vacuous.
        expect(mockedCreateClient).toHaveBeenCalledWith(
          URL,
          SERVICE_ROLE_KEY,
          SERVER_AUTH_OPTIONS,
        );
        expect(logged).not.toContain(SERVICE_ROLE_KEY);
        expect(logged).not.toContain(URL);
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });
  });
});

/**
 * Structural guarantees around the privileged path.
 *
 * These assert the *shape* of the code — which provider owns the credential, and
 * what module exports it — because those are properties a reviewer can verify.
 * They deliberately do not claim that a TypeScript `private` field is
 * unreachable at runtime: it is not a security boundary, and unsafe casts can
 * read it. What matters is that nothing in the design hands a service-role
 * client to a caller.
 */
describe('privileged-read surface', () => {
  it('SupabaseService has gained no service-role client factory', () => {
    const members = Object.getOwnPropertyNames(
      SupabaseService.prototype,
    ).filter((member) => member !== 'constructor');

    // The anon-key surface is unchanged, and nothing service-role-shaped exists.
    expect(members.sort()).toEqual([
      'createAuthClient',
      'createUserClient',
      'serverAuthOptions',
    ]);
    expect(members.filter((member) => /service/i.test(member))).toEqual([]);
  });

  it('keeps the reader prototype to its one operation and private helper', () => {
    // A change detector on the surface this provider presents: adding anything
    // that could hand out a client fails here and gets reviewed.
    const members = Object.getOwnPropertyNames(
      InternalHoldingsService.prototype,
    ).filter((member) => member !== 'constructor');

    expect(members.sort()).toEqual([
      'getInternalValuationHoldings',
      'supabaseClient',
    ]);
  });

  it('registers InternalHoldingsService in PortfoliosModule and exports it for Slice 3B.2', () => {
    const providers = Reflect.getMetadata('providers', PortfoliosModule) ?? [];
    const exported = Reflect.getMetadata('exports', PortfoliosModule) ?? [];

    expect(providers).toContain(InternalHoldingsService);
    // Exported for its one consumer, the realtime recalculation coordinator —
    // and only as a service returning plain holdings.
    expect(exported).toContain(InternalHoldingsService);
  });

  it('is not injected by the portfolios controller', () => {
    const paramTypes =
      Reflect.getMetadata('design:paramtypes', PortfoliosController) ?? [];

    expect(paramTypes).not.toContain(InternalHoldingsService);
  });
});
