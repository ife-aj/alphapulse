import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { MarketService } from '../market/market.service';
import { SupabaseService } from '../supabase/supabase.service';
import { PortfoliosValuationService } from './portfolio-valuation.service';
import { VALUATION_QUOTE_CONCURRENCY } from './concurrency';
import type { ValuationHolding } from './valuation-computation';

/** Scripted PostgREST response. */
type Result = { data: unknown; error: unknown };

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const TOKEN = 'token-1';

function buildChain(result: () => Result, calls: { method: string; args: unknown[] }[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'order', 'eq']) {
    chain[method] = jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.maybeSingle = jest.fn(() => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(result());
  });
  chain.then = (resolve: (v: Result) => void) => {
    calls.push({ method: 'then', args: [] });
    resolve(result());
  };
  return chain;
}

function buildSupabase(results: Result[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const from = jest.fn();
  for (const result of results) {
    from.mockReturnValueOnce(buildChain(() => result, calls));
  }
  const createUserClient = jest.fn().mockReturnValue({ from });
  const supabase = { createUserClient } as unknown as SupabaseService;
  return { supabase, createUserClient, from, calls };
}

function buildService(
  supabase: SupabaseService,
  market: { getQuotes: jest.Mock },
): PortfoliosValuationService {
  return new PortfoliosValuationService(
    supabase,
    market as unknown as MarketService,
  );
}

/** A quote object in the provider's response shape. */
function quote(price: number) {
  return { symbol: 'X', price, change: 0, changePercent: 0, timestamp: '0' };
}

describe('PortfoliosValuationService', () => {
  it('returns a neutral 404 when the portfolio is missing or RLS-hidden', async () => {
    const { supabase } = buildSupabase([{ data: null, error: null }]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(
      service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(market.getQuotes).not.toHaveBeenCalled();
  });

  it('maps a portfolio-read database failure through the error mapper', async () => {
    const { supabase } = buildSupabase([
      { data: null, error: { code: 'XX000', message: 'internal error' } },
    ]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(
      service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(market.getQuotes).not.toHaveBeenCalled();
  });

  it('returns zero totals for an empty portfolio and makes NO market calls', async () => {
    const { supabase, calls } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      { data: [], error: null },
    ]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID)).resolves.toEqual(
      {
        portfolioId: PORTFOLIO_ID,
        totalInvestedValue: '0.00',
        totalCurrentValue: '0.00',
        totalProfitLoss: '0.00',
        totalReturnPercentage: '0.00',
        holdings: [],
      },
    );

    expect(market.getQuotes).not.toHaveBeenCalled();
    // Read-only: only selects happened; the empty portfolio issued no write.
    expect(calls.some((c) => c.method === 'select')).toBe(true);
    expect(calls.some((c) => c.method === 'insert' || c.method === 'update' || c.method === 'delete')).toBe(false);
  });

  it('values a single holding from the exact provider price without premature rounding', async () => {
    const { supabase, calls } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [
          {
            symbol: 'AAPL',
            quantity: 10,
            average_purchase_price: '100',
          },
        ],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest.fn().mockResolvedValue([quote(182.7465)]),
    };
    const service = buildService(supabase, market);

    await expect(service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID)).resolves.toEqual(
      {
        portfolioId: PORTFOLIO_ID,
        // Exact math: 10 × 182.7465 = 1827.465 → 1827.47 (had the quote been
        // rounded to cents first, this would read 1827.50).
        totalInvestedValue: '1000.00',
        totalCurrentValue: '1827.47',
        totalProfitLoss: '827.47',
        totalReturnPercentage: '82.75',
        holdings: [
          {
            symbol: 'AAPL',
            quantity: '10',
            averagePurchasePrice: '100',
            // The displayed price is the exact provider value — never rounded to
            // cents — so it agrees with the calculated currentValue.
            currentPrice: '182.7465',
            investedValue: '1000.00',
            currentValue: '1827.47',
            profitLoss: '827.47',
            returnPercentage: '82.75',
          },
        ],
      },
    );

    expect(market.getQuotes).toHaveBeenCalledTimes(1);
    expect(market.getQuotes).toHaveBeenCalledWith(['AAPL']);
    expect(
      calls.some(
        (c) =>
          c.method === 'eq' &&
          c.args[0] === 'user_id' &&
          c.args[1] === USER_ID,
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === 'eq' &&
          c.args[0] === 'portfolio_id' &&
          c.args[1] === PORTFOLIO_ID,
      ),
    ).toBe(true);
    // The holdings read is intentionally narrow (no id/timestamps fetched).
    const holdingsSelect = calls.find(
      (c) => c.method === 'select' && c.args[0] === 'symbol, quantity, average_purchase_price',
    );
    expect(holdingsSelect).toBeDefined();
  });

  it('echoes the exact provider price and derives currentValue from it (12.5 × "182.7465" = "2284.33")', async () => {
    const { supabase } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [
          { symbol: 'AAPL', quantity: 12.5, average_purchase_price: 150 },
        ],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest.fn().mockResolvedValue([quote(182.7465)]),
    };
    const service = buildService(supabase, market);

    await expect(service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID)).resolves.toEqual(
      {
        portfolioId: PORTFOLIO_ID,
        totalInvestedValue: '1875.00',
        totalCurrentValue: '2284.33',
        totalProfitLoss: '409.33',
        totalReturnPercentage: '21.83',
        holdings: [
          {
            symbol: 'AAPL',
            quantity: '12.5',
            averagePurchasePrice: '150',
            // Exact, unrounded provider price — NOT forced to two decimals.
            currentPrice: '182.7465',
            investedValue: '1875.00',
            // Calculated from the exact price (12.5 × 182.7465 = 2284.33125),
            // rounded only at serialization to two decimals.
            currentValue: '2284.33',
            profitLoss: '409.33',
            returnPercentage: '21.83',
          },
        ],
      },
    );
  });

  it('aggregates several holdings, rounding totals once from exact sums', async () => {
    const { supabase, calls } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [
          { symbol: 'AAPL', quantity: 12.5, average_purchase_price: 152.3755 },
          { symbol: 'MSFT', quantity: 4, average_purchase_price: 60 },
        ],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest.fn().mockImplementation((symbols: string[]) =>
        Promise.resolve([quote(symbols[0] === 'AAPL' ? 182.75 : 70)]),
      ),
    };
    const service = buildService(supabase, market);

    await expect(service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID)).resolves.toEqual(
      {
        portfolioId: PORTFOLIO_ID,
        totalInvestedValue: '2144.69',
        totalCurrentValue: '2564.38',
        totalProfitLoss: '419.68',
        totalReturnPercentage: '19.57',
        holdings: [
          {
            symbol: 'AAPL',
            quantity: '12.5',
            averagePurchasePrice: '152.3755',
            currentPrice: '182.75',
            investedValue: '1904.69',
            currentValue: '2284.38',
            profitLoss: '379.68',
            returnPercentage: '19.93',
          },
          {
            symbol: 'MSFT',
            quantity: '4',
            averagePurchasePrice: '60',
            // Canonical form: the exact provider price, no forced cents.
            currentPrice: '70',
            investedValue: '240.00',
            currentValue: '280.00',
            profitLoss: '40.00',
            returnPercentage: '16.67',
          },
        ],
      },
    );

    // One bounded request per symbol, no writes.
    expect(market.getQuotes).toHaveBeenCalledTimes(2);
    expect(market.getQuotes).toHaveBeenCalledWith(['AAPL']);
    expect(market.getQuotes).toHaveBeenCalledWith(['MSFT']);
    expect(calls.some((c) => c.method === 'insert' || c.method === 'update' || c.method === 'delete')).toBe(false);
  });

  it('translates an unknown-symbol provider 404 into a 422 valuation error', async () => {
    const { supabase } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [{ symbol: 'ZZZZ', quantity: 1, average_purchase_price: 10 }],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest.fn().mockRejectedValue(new NotFoundException('Unknown symbol "ZZZZ"')),
    };
    const service = buildService(supabase, market);

    const error = await service
      .getValuation(USER_ID, TOKEN, PORTFOLIO_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect(JSON.stringify((error as UnprocessableEntityException).getResponse())).toContain('ZZZZ');
  });

  it('rejects a non-positive or non-finite provider price as unprocessable', async () => {
    for (const badPrice of [0, -1, NaN]) {
      const { supabase } = buildSupabase([
        { data: { id: PORTFOLIO_ID }, error: null },
        {
          data: [{ symbol: 'AAPL', quantity: 1, average_purchase_price: 10 }],
          error: null,
        },
      ]);
      const market = {
        getQuotes: jest.fn().mockResolvedValue([quote(badPrice)]),
      };
      const service = buildService(supabase, market);

      await expect(
        service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
  });

  it('passes provider transport failures through unchanged', async () => {
    const { supabase } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [{ symbol: 'AAPL', quantity: 1, average_purchase_price: 10 }],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('Market data is temporarily unavailable.')),
    };
    const service = buildService(supabase, market);

    await expect(
      service.getValuation(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails all-or-nothing when any symbol cannot be valued', async () => {
    const { supabase } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [
          { symbol: 'AAPL', quantity: 1, average_purchase_price: 10 },
          { symbol: 'ZZZZ', quantity: 1, average_purchase_price: 10 },
        ],
        error: null,
      },
    ]);
    const market = {
      getQuotes: jest.fn().mockImplementation((symbols: string[]) => {
        if (symbols[0] === 'ZZZZ') {
          return Promise.reject(new NotFoundException('Unknown symbol "ZZZZ"'));
        }
        return Promise.resolve([quote(100)]);
      }),
    };
    const service = buildService(supabase, market);

    const error = await service
      .getValuation(USER_ID, TOKEN, PORTFOLIO_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
  });
});

describe('PortfoliosValuationService.getValuationHoldings', () => {
  it('returns normalized holdings from the narrow, ordered, user-scoped query', async () => {
    const { supabase, createUserClient, calls } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      {
        data: [
          { symbol: 'AAPL', quantity: 10, average_purchase_price: '100' },
          {
            symbol: 'MSFT',
            quantity: '12.500000',
            average_purchase_price: '152.3755',
          },
        ],
        error: null,
      },
    ]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    const holdings = await service.getValuationHoldings(
      USER_ID,
      TOKEN,
      PORTFOLIO_ID,
    );

    // Numeric DB cells are normalized into exact Decimals (raw rows never leave
    // the portfolios module) and the loader never touches the market.
    expect(holdings).toHaveLength(2);
    expect(holdings[0].quantity).toBeInstanceOf(Decimal);
    expect(
      holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity.toString(),
        averagePurchasePrice: h.averagePurchasePrice.toString(),
      })),
    ).toEqual([
      { symbol: 'AAPL', quantity: '10', averagePurchasePrice: '100' },
      { symbol: 'MSFT', quantity: '12.5', averagePurchasePrice: '152.3755' },
    ]);

    // Ownership is scoped to the authenticated user; the holdings read is the
    // same narrow select, ordered by symbol, as the REST valuation.
    expect(createUserClient).toHaveBeenCalledWith(TOKEN);
    expect(
      calls.some(
        (c) =>
          c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID,
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === 'eq' &&
          c.args[0] === 'portfolio_id' &&
          c.args[1] === PORTFOLIO_ID,
      ),
    ).toBe(true);
    const holdingsSelect = calls.find(
      (c) =>
        c.method === 'select' &&
        c.args[0] === 'symbol, quantity, average_purchase_price',
    );
    expect(holdingsSelect).toBeDefined();
    expect(
      calls.some((c) => c.method === 'order' && c.args[0] === 'symbol'),
    ).toBe(true);
    expect(market.getQuotes).not.toHaveBeenCalled();
  });

  it('returns the same neutral 404 for a missing or RLS-hidden portfolio', async () => {
    // Under RLS a foreign portfolio and a nonexistent one both read back as
    // `null`; the loader produces the identical neutral NotFoundException.
    const { supabase } = buildSupabase([{ data: null, error: null }]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(
      service.getValuationHoldings(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(market.getQuotes).not.toHaveBeenCalled();
  });

  it('maps a portfolio-read database failure through the error mapper', async () => {
    const { supabase } = buildSupabase([
      { data: null, error: { code: 'XX000', message: 'internal error' } },
    ]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(
      service.getValuationHoldings(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a holdings-read database failure through the error mapper', async () => {
    const { supabase } = buildSupabase([
      { data: { id: PORTFOLIO_ID }, error: null },
      { data: null, error: { code: 'XX000', message: 'internal error' } },
    ]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(
      service.getValuationHoldings(USER_ID, TOKEN, PORTFOLIO_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(market.getQuotes).not.toHaveBeenCalled();
  });
});

describe('PortfoliosValuationService.valueHoldings', () => {
  function holding(
    symbol: string,
    quantity: string,
    averagePurchasePrice: string,
  ): ValuationHolding {
    return {
      symbol,
      quantity: new Decimal(quantity),
      averagePurchasePrice: new Decimal(averagePurchasePrice),
    };
  }

  it('returns the exact zero valuation for empty holdings and makes NO market calls', async () => {
    const { supabase, createUserClient } = buildSupabase([]);
    const market = { getQuotes: jest.fn() };
    const service = buildService(supabase, market);

    await expect(service.valueHoldings(PORTFOLIO_ID, [])).resolves.toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '0.00',
      totalCurrentValue: '0.00',
      totalProfitLoss: '0.00',
      totalReturnPercentage: '0.00',
      holdings: [],
    });
    expect(market.getQuotes).not.toHaveBeenCalled();
    // Pricing/computation only — valueHoldings never touches the database.
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('fetches prices through the bounded-concurrency pool, never Promise.all over all symbols', async () => {
    const holdings = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].map(
      (symbol, index) => holding(symbol, '1', String(index + 1)),
    );
    // The first VALUATION_QUOTE_CONCURRENCY fetches park; any later one resolves
    // immediately once an earlier slot frees up.
    const parked: Array<() => void> = [];
    let calls = 0;
    const market = {
      getQuotes: jest.fn((symbols: string[]) => {
        calls += 1;
        if (calls <= VALUATION_QUOTE_CONCURRENCY) {
          return new Promise((resolve) => {
            parked.push(() => resolve([quote(100)]));
          });
        }
        return Promise.resolve([quote(100)]);
      }),
    };
    const service = buildService(buildSupabase([]).supabase, market);

    const resultPromise = service.valueHoldings(PORTFOLIO_ID, holdings);

    // The pool starts exactly VALUATION_QUOTE_CONCURRENCY workers; the remaining
    // symbols are not scheduled until one of the parked fetches completes.
    expect(calls).toBe(VALUATION_QUOTE_CONCURRENCY);

    parked.forEach((release) => release());
    const dto = await resultPromise;
    expect(calls).toBe(holdings.length);
    expect(dto.holdings).toHaveLength(holdings.length);
  });

  it('pairs each price with the holding in its original position', async () => {
    const market = {
      getQuotes: jest.fn().mockImplementation((symbols: string[]) => {
        const priceBySymbol: Record<string, number> = {
          AAPL: 182.75,
          MSFT: 70,
        };
        return Promise.resolve([quote(priceBySymbol[symbols[0]] ?? 0)]);
      }),
    };
    const service = buildService(buildSupabase([]).supabase, market);

    await expect(
      service.valueHoldings(PORTFOLIO_ID, [
        holding('AAPL', '12.5', '152.3755'),
        holding('MSFT', '4', '60'),
      ]),
    ).resolves.toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '2144.69',
      totalCurrentValue: '2564.38',
      totalProfitLoss: '419.68',
      totalReturnPercentage: '19.57',
      holdings: [
        {
          symbol: 'AAPL',
          quantity: '12.5',
          averagePurchasePrice: '152.3755',
          currentPrice: '182.75',
          investedValue: '1904.69',
          currentValue: '2284.38',
          profitLoss: '379.68',
          returnPercentage: '19.93',
        },
        {
          symbol: 'MSFT',
          quantity: '4',
          averagePurchasePrice: '60',
          currentPrice: '70',
          investedValue: '240.00',
          currentValue: '280.00',
          profitLoss: '40.00',
          returnPercentage: '16.67',
        },
      ],
    });
    expect(market.getQuotes).toHaveBeenNthCalledWith(1, ['AAPL']);
    expect(market.getQuotes).toHaveBeenNthCalledWith(2, ['MSFT']);
  });

  it('retains the unknown-symbol provider 404 → 422 translation', async () => {
    const market = {
      getQuotes: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Unknown symbol "ZZZZ"')),
    };
    const service = buildService(buildSupabase([]).supabase, market);

    const error = await service
      .valueHoldings(PORTFOLIO_ID, [holding('ZZZZ', '1', '10')])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect(
      JSON.stringify((error as UnprocessableEntityException).getResponse()),
    ).toContain('ZZZZ');
  });

  it('passes provider transport and rate-limit failures through unchanged', async () => {
    const market = {
      getQuotes: jest
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException(
            'Market data is temporarily unavailable.',
          ),
        ),
    };
    const service = buildService(buildSupabase([]).supabase, market);

    await expect(
      service.valueHoldings(PORTFOLIO_ID, [holding('AAPL', '1', '10')]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a non-positive or non-finite provider price as unprocessable (checked before Decimal construction)', async () => {
    for (const badPrice of [0, -1, NaN]) {
      const market = {
        getQuotes: jest.fn().mockResolvedValue([quote(badPrice)]),
      };
      const service = buildService(buildSupabase([]).supabase, market);

      await expect(
        service.valueHoldings(PORTFOLIO_ID, [holding('AAPL', '1', '10')]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
  });

  it('fails all-or-nothing when any symbol cannot be valued', async () => {
    const market = {
      getQuotes: jest.fn().mockImplementation((symbols: string[]) => {
        if (symbols[0] === 'ZZZZ') {
          return Promise.reject(new NotFoundException('Unknown symbol "ZZZZ"'));
        }
        return Promise.resolve([quote(100)]);
      }),
    };
    const service = buildService(buildSupabase([]).supabase, market);

    const error = await service
      .valueHoldings(PORTFOLIO_ID, [
        holding('AAPL', '1', '10'),
        holding('ZZZZ', '1', '10'),
      ])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
  });
});
