import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { MarketService } from '../market/market.service';
import type { InternalHoldingsService } from '../portfolios/internal-holdings.service';
import { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import type { ValuationHolding } from '../portfolios/valuation-computation';
import type { SupabaseService } from '../supabase/supabase.service';
import {
  RECALCULATION_PORTFOLIO_CONCURRENCY,
  RealtimeRecalculationService,
} from './realtime-recalculation.service';
import type { RealtimePriceRefreshService } from './realtime-price-refresh.service';
import type { RealtimeSubscriptionService } from './realtime-subscription.service';
import type { ActivePortfolioIdentity } from './realtime.types';

/**
 * Recalculation-cycle unit tests over the real `RealtimeRecalculationService`
 * and the real `PortfoliosValuationService`, with scripted registry, holdings,
 * and price collaborators. Deterministic deferred promises (never arbitrary
 * sleeps) drive every concurrency, snapshot, and overlap case.
 *
 * The valuation service is deliberately the real one: these tests assert that a
 * cycle makes **no** provider call of its own and never touches the
 * token-based REST path, which a stub could not show.
 */

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const PORTFOLIO_1 = '11111111-1111-4111-8111-111111111111';
const PORTFOLIO_2 = '22222222-2222-4222-8222-222222222222';

const AAPL = 'AAPL';
const MSFT = 'MSFT';
const TSLA = 'TSLA';

/** A deferred we can resolve/reject on demand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A normalized holding in the domain shape the internal reader returns. */
function holding(
  symbol: string,
  quantity = '10',
  averagePurchasePrice = '100',
): ValuationHolding {
  return {
    symbol,
    quantity: new Decimal(quantity),
    averagePurchasePrice: new Decimal(averagePurchasePrice),
  };
}

function identity(
  userId: string,
  portfolioId: string,
): ActivePortfolioIdentity {
  return { userId, portfolioId };
}

function makeRegistry(identities: ActivePortfolioIdentity[] = []) {
  return {
    getActivePortfolioIdentities: jest.fn((): ActivePortfolioIdentity[] =>
      identities.map((entry) => ({ ...entry })),
    ),
  };
}

type RegistryStub = ReturnType<typeof makeRegistry>;

function makeHoldings() {
  return { getInternalValuationHoldings: jest.fn() };
}

type HoldingsStub = ReturnType<typeof makeHoldings>;

function makePriceRefresh() {
  return {
    // A cycle with nothing to price is a valid, empty result — callers always
    // receive a shape, never `undefined`.
    priceSymbols: jest.fn(() =>
      Promise.resolve({
        prices: new Map<string, Decimal>(),
        failedSymbols: [] as string[],
      }),
    ),
  };
}

type PriceStub = ReturnType<typeof makePriceRefresh>;

/** Script a price per symbol; anything absent is reported as a failed symbol. */
function stubPrices(
  priceRefresh: PriceStub,
  bySymbol: Record<string, string>,
): void {
  priceRefresh.priceSymbols.mockImplementation((symbols: string[]) => {
    const prices = new Map<string, Decimal>();
    const failedSymbols: string[] = [];
    for (const symbol of symbols) {
      const price = bySymbol[symbol];
      if (price === undefined) {
        failedSymbols.push(symbol);
      } else {
        prices.set(symbol, new Decimal(price));
      }
    }
    return Promise.resolve({ prices, failedSymbols });
  });
}

/** The real valuation service over a Supabase stub the cycle must never reach. */
function makeValuation() {
  const supabase = {
    createUserClient: jest.fn(),
  } as unknown as SupabaseService;
  const market = { getQuotes: jest.fn() };
  return {
    market,
    service: new PortfoliosValuationService(
      supabase,
      market as unknown as MarketService,
    ),
  };
}

function makeService(
  registry: RegistryStub = makeRegistry(),
  holdings: HoldingsStub = makeHoldings(),
  priceRefresh: PriceStub = makePriceRefresh(),
  valuation = makeValuation(),
) {
  return {
    registry,
    holdings,
    priceRefresh,
    valuation,
    service: new RealtimeRecalculationService(
      registry as unknown as RealtimeSubscriptionService,
      holdings as unknown as InternalHoldingsService,
      priceRefresh as unknown as RealtimePriceRefreshService,
      valuation.service,
    ),
  };
}

/** Successful holdings reads, keyed by portfolio id, in call order. */
function stubHoldings(
  holdings: HoldingsStub,
  byPortfolio: Record<string, ValuationHolding[] | Error>,
): void {
  holdings.getInternalValuationHoldings.mockImplementation(
    (_userId: string, portfolioId: string) => {
      const response = byPortfolio[portfolioId];
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    },
  );
}

/** The symbols each `priceSymbols` call requested, in call order. */
function requestedSymbolSets(priceRefresh: PriceStub): string[][] {
  return priceRefresh.priceSymbols.mock.calls.map(
    (call: unknown[]) => call[0] as string[],
  );
}

describe('RealtimeRecalculationService', () => {
  describe('starting snapshot', () => {
    it('does nothing at all when no portfolio is active', async () => {
      const { holdings, priceRefresh, service } = makeService();

      const result = await service.recalculate();

      expect(holdings.getInternalValuationHoldings).not.toHaveBeenCalled();
      expect(priceRefresh.priceSymbols).toHaveBeenCalledWith([]);
      expect(result.results).toEqual([]);
      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([]);
    });

    it('snapshots identities at cycle start, so registry changes wait for the next cycle', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      const gate = deferred<ValuationHolding[]>();
      holdings.getInternalValuationHoldings.mockReturnValueOnce(gate.promise);
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const cycle = service.recalculate();
      await flush();

      // The registry gains a second portfolio while the cycle is still running.
      registry.getActivePortfolioIdentities.mockReturnValue([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_A, PORTFOLIO_2),
      ]);

      gate.resolve([holding(AAPL)]);
      const result = await cycle;

      // The in-flight cycle is untouched: the new portfolio was never read.
      expect(holdings.getInternalValuationHoldings).toHaveBeenCalledTimes(1);
      expect(result.results).toHaveLength(1);

      // The next cycle picks up the new snapshot.
      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL)],
        [PORTFOLIO_2]: [holding(MSFT)],
      });
      stubPrices(priceRefresh, { [AAPL]: '150', [MSFT]: '300' });
      const next = await service.recalculate();

      expect(next.results).toHaveLength(2);
    });
  });

  describe('symbol sourcing', () => {
    it('fetches a symbol two portfolios share exactly once, and reuses the one price', async () => {
      const registry = makeRegistry([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_B, PORTFOLIO_2),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL, '10')],
        [PORTFOLIO_2]: [holding(AAPL, '4')],
      });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      expect(requestedSymbolSets(priceRefresh)).toEqual([[AAPL]]);
      expect(result.prices.get(AAPL)?.toString()).toBe('150');

      const [first, second] = result.results;
      expect(first).toMatchObject({ ok: true, portfolioId: PORTFOLIO_1 });
      expect(second).toMatchObject({ ok: true, portfolioId: PORTFOLIO_2 });
      // Both valuations were built from the cycle's one shared price.
      const firstValuation = first.ok ? first.valuation : null;
      const secondValuation = second.ok ? second.valuation : null;
      expect(firstValuation?.holdings[0].currentPrice).toBe('150');
      expect(secondValuation?.holdings[0].currentPrice).toBe('150');
      expect(firstValuation?.totalCurrentValue).toBe('1500.00');
      expect(secondValuation?.totalCurrentValue).toBe('600.00');
    });

    it('prices a holding added over REST after subscribing, which the registry never saw', async () => {
      // The drift case: the registry's symbol snapshot is only ever refreshed
      // by a successful subscribe, so after `POST /holdings` it still reports
      // AAPL alone while the database already returns AAPL and TSLA.
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL, '10'), holding(TSLA, '2')],
      });
      stubPrices(priceRefresh, { [AAPL]: '150', [TSLA]: '250' });

      const result = await service.recalculate();

      // TSLA is priced because it is held, not because it is registered.
      expect(requestedSymbolSets(priceRefresh)).toEqual([[AAPL, TSLA]]);
      expect(result.results[0]).toMatchObject({ ok: true });
      const valuation = result.results[0].ok
        ? result.results[0].valuation
        : null;
      // 10 × 150 + 2 × 250 = 2000 — the added holding is valued, not omitted.
      expect(valuation?.totalCurrentValue).toBe('2000.00');
      // The registry's stale symbol snapshot is never consulted.
      expect(
        (registry as unknown as { getActiveSymbols?: unknown })
          .getActiveSymbols,
      ).toBeUndefined();
    });

    it('never prices a symbol the holdings no longer contain', async () => {
      // The mirror drift: a holding deleted over REST drops out of the union,
      // so it costs no provider call.
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL, '10')] });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      await service.recalculate();

      const requested = requestedSymbolSets(priceRefresh)[0];
      expect(requested).toEqual([AAPL]);
      expect(requested).not.toContain(TSLA);
    });

    it('prices nothing when every holdings read failed', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new ServiceUnavailableException('provider down'),
      });
      stubPrices(priceRefresh, {});

      const result = await service.recalculate();

      // A failed read has no known symbols, so it costs no provider call.
      expect(requestedSymbolSets(priceRefresh)).toEqual([[]]);
      expect(result.results[0]).toMatchObject({
        ok: false,
        code: 'HOLDINGS_UNAVAILABLE',
        unpricedSymbols: [],
      });
    });
  });

  describe('price-missing atomic failure', () => {
    it('fails only the portfolio that holds the unpriced symbol', async () => {
      const registry = makeRegistry([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_B, PORTFOLIO_2),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL, '10'), holding(TSLA, '2')],
        [PORTFOLIO_2]: [holding(AAPL, '10')],
      });
      // TSLA cannot be priced; AAPL can.
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      // Portfolio 1 fails atomically rather than publishing 1500 as its total.
      expect(result.results[0]).toMatchObject({
        ok: false,
        portfolioId: PORTFOLIO_1,
        code: 'MISSING_PRICE',
        unpricedSymbols: [TSLA],
      });
      expect(result.results[0]).not.toHaveProperty('valuation');

      // Portfolio 2 is unaffected.
      expect(result.results[1]).toMatchObject({
        ok: true,
        portfolioId: PORTFOLIO_2,
      });
      expect(result.failedSymbols).toEqual([TSLA]);
    });

    it('never substitutes a zero for a missing price', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL, '10'), holding(TSLA, '2')],
      });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      const serialized = JSON.stringify(result);
      // No valuation was produced, so no total was published at all.
      expect(serialized).not.toContain('totalCurrentValue');
      expect(result.results[0]).toMatchObject({
        ok: false,
        unpricedSymbols: [TSLA],
      });
    });

    it('reports every unpriced symbol once, normalized and sorted', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      // Duplicate rows, mixed casing, and an already-missing symbol.
      stubHoldings(holdings, {
        [PORTFOLIO_1]: [
          holding(TSLA, '1'),
          holding('tsla', '2'),
          holding(MSFT, '3'),
          holding(AAPL, '4'),
        ],
      });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      expect(result.results[0]).toMatchObject({
        ok: false,
        code: 'MISSING_PRICE',
        unpricedSymbols: [MSFT, TSLA],
      });
    });
  });

  describe('portfolio failure isolation', () => {
    it('keeps the other portfolios when one holdings read fails', async () => {
      const registry = makeRegistry([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_B, PORTFOLIO_2),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new NotFoundException('Portfolio not found.'),
        [PORTFOLIO_2]: [holding(AAPL, '10')],
      });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      // The neutral 404 classifies as a not-found, and discards nothing else.
      expect(result.results[0]).toMatchObject({
        ok: false,
        portfolioId: PORTFOLIO_1,
        code: 'PORTFOLIO_NOT_FOUND',
      });
      expect(result.results[1]).toMatchObject({
        ok: true,
        portfolioId: PORTFOLIO_2,
      });
    });

    it('resolves every portfolio as a failure rather than rejecting the cycle', async () => {
      const registry = makeRegistry([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_B, PORTFOLIO_2),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new ServiceUnavailableException('provider down'),
        [PORTFOLIO_2]: new NotFoundException('Portfolio not found.'),
      });
      stubPrices(priceRefresh, {});

      const result = await service.recalculate();

      expect(result.results).toHaveLength(2);
      expect(result.results.map((entry) => entry.ok)).toEqual([false, false]);
      expect(result.results.map((entry) => !entry.ok && entry.code)).toEqual([
        'HOLDINGS_UNAVAILABLE',
        'PORTFOLIO_NOT_FOUND',
      ]);
    });

    it('keeps a failure from one cycle out of the next', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new ServiceUnavailableException('provider down'),
      });
      stubPrices(priceRefresh, {});
      const failed = await service.recalculate();
      expect(failed.results[0]).toMatchObject({ ok: false });

      // The guard recovered, so the next cycle runs and can succeed.
      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL, '10')] });
      stubPrices(priceRefresh, { [AAPL]: '150' });
      const next = await service.recalculate();

      expect(next.results[0]).toMatchObject({ ok: true });
    });
  });

  describe('empty holdings', () => {
    it('treats an owned-but-empty portfolio as a valid zero valuation', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, { [PORTFOLIO_1]: [] });
      stubPrices(priceRefresh, {});

      const result = await service.recalculate();

      expect(result.results[0]).toMatchObject({ ok: true });
      const valuation = result.results[0].ok
        ? result.results[0].valuation
        : null;
      expect(valuation).toMatchObject({
        portfolioId: PORTFOLIO_1,
        totalInvestedValue: '0.00',
        totalCurrentValue: '0.00',
        totalProfitLoss: '0.00',
        totalReturnPercentage: '0.00',
        holdings: [],
      });
      // An empty portfolio contributes no symbol to price.
      expect(requestedSymbolSets(priceRefresh)).toEqual([[]]);
    });

    it('does not let an empty portfolio mask another one failing', async () => {
      const registry = makeRegistry([
        identity(USER_A, PORTFOLIO_1),
        identity(USER_B, PORTFOLIO_2),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [],
        [PORTFOLIO_2]: new ServiceUnavailableException('provider down'),
      });
      stubPrices(priceRefresh, {});

      const result = await service.recalculate();

      expect(result.results[0]).toMatchObject({ ok: true });
      expect(result.results[1]).toMatchObject({
        ok: false,
        code: 'HOLDINGS_UNAVAILABLE',
      });
    });
  });

  describe('deterministic ordering', () => {
    it('reports one result per snapshot entry, in the snapshot’s own order', async () => {
      // Ordering is the registry's guarantee — `getActivePortfolioIdentities`
      // sorts by identity, and that is asserted in the registry's own spec.
      // The cycle's contract is that it preserves the order it was handed and
      // reports exactly one result per entry, so a deliberately unsorted
      // snapshot must come back untouched and undeduplicated.
      const registry = makeRegistry([
        identity(USER_B, PORTFOLIO_2),
        identity(USER_A, PORTFOLIO_2),
        identity(USER_A, PORTFOLIO_1),
      ]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(AAPL)],
        [PORTFOLIO_2]: [holding(AAPL)],
      });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const result = await service.recalculate();

      expect(
        result.results.map((entry) => `${entry.userId}|${entry.portfolioId}`),
      ).toEqual([
        `${USER_B}|${PORTFOLIO_2}`,
        `${USER_A}|${PORTFOLIO_2}`,
        `${USER_A}|${PORTFOLIO_1}`,
      ]);
    });

    it('sorts the priced map and the failure list by symbol', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: [holding(TSLA), holding(AAPL), holding(MSFT)],
      });
      // The stub echoes the request order, which the cycle must have sorted.
      stubPrices(priceRefresh, { [AAPL]: '150', [MSFT]: '300' });

      const result = await service.recalculate();

      expect(requestedSymbolSets(priceRefresh)).toEqual([[AAPL, MSFT, TSLA]]);
      expect([...result.prices.keys()]).toEqual([AAPL, MSFT]);
      expect(result.failedSymbols).toEqual([TSLA]);
    });

    it('returns fresh collections each cycle', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL)] });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const first = await service.recalculate();
      first.results.length = 0;
      first.failedSymbols.push('MUTATED');
      first.prices.set('MUTATED', new Decimal(1));

      const second = await service.recalculate();

      expect(second.results).toHaveLength(1);
      expect(second.failedSymbols).toEqual([]);
      expect([...second.prices.keys()]).toEqual([AAPL]);
    });
  });

  describe('bounded concurrency', () => {
    it('never runs more than the configured holdings reads concurrently', async () => {
      const identities = Array.from({ length: 12 }, (_, index) =>
        identity(`user-${String(index).padStart(2, '0')}`, PORTFOLIO_1),
      );
      const registry = makeRegistry(identities);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      const gates = new Map<
        string,
        ReturnType<typeof deferred<ValuationHolding[]>>
      >();
      let inFlight = 0;
      let peak = 0;
      holdings.getInternalValuationHoldings.mockImplementation(
        (userId: string) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          const gate = deferred<ValuationHolding[]>();
          gates.set(userId, gate);
          return gate.promise.finally(() => {
            inFlight -= 1;
          });
        },
      );
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const cycle = service.recalculate();
      await flush();

      // Exactly the bound's worth of reads started, no more.
      expect(peak).toBe(RECALCULATION_PORTFOLIO_CONCURRENCY);
      expect([...gates.keys()]).toEqual([
        'user-00',
        'user-01',
        'user-02',
        'user-03',
        'user-04',
      ]);

      // Releasing one admits exactly one more, never two.
      for (const identityEntry of identities) {
        const gate = gates.get(identityEntry.userId);
        if (gate === undefined) {
          throw new Error(
            `expected a pending read for ${identityEntry.userId}`,
          );
        }
        gate.resolve([holding(AAPL)]);
        await flush();
        expect(peak).toBe(RECALCULATION_PORTFOLIO_CONCURRENCY);
      }

      const result = await cycle;
      expect(result.results).toHaveLength(identities.length);
    });
  });

  describe('overlapping cycles', () => {
    it('coalesces concurrent calls into a single cycle', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      const gate = deferred<ValuationHolding[]>();
      holdings.getInternalValuationHoldings.mockReturnValueOnce(gate.promise);
      stubPrices(priceRefresh, { [AAPL]: '150' });

      const first = service.recalculate();
      const second = service.recalculate();
      await flush();

      // Concurrent callers share the one running cycle: one holdings read, one
      // price request, and the identical promise object (recalculate is
      // deliberately not `async`).
      expect(second).toBe(first);
      expect(holdings.getInternalValuationHoldings).toHaveBeenCalledTimes(1);
      expect(priceRefresh.priceSymbols).toHaveBeenCalledTimes(0);

      gate.resolve([holding(AAPL)]);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toBe(secondResult);
      expect(priceRefresh.priceSymbols).toHaveBeenCalledTimes(1);
      expect(firstResult.results[0]).toMatchObject({ ok: true });
    });

    it('starts a new cycle for a call made after completion', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL)] });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      await service.recalculate();
      expect(holdings.getInternalValuationHoldings).toHaveBeenCalledTimes(1);

      await service.recalculate();

      expect(holdings.getInternalValuationHoldings).toHaveBeenCalledTimes(2);
      expect(priceRefresh.priceSymbols).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight guard after a cycle in which everything failed', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new ServiceUnavailableException('provider down'),
      });
      stubPrices(priceRefresh, {});
      const failed = await service.recalculate();
      expect(failed.results[0]).toMatchObject({ ok: false });

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL)] });
      stubPrices(priceRefresh, { [AAPL]: '150' });
      const next = await service.recalculate();

      expect(next.results[0]).toMatchObject({ ok: true });
    });
  });

  describe('boundaries', () => {
    it('never uses the token-based REST valuation path', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const valuation = makeValuation();
      const { service } = makeService(
        registry,
        holdings,
        priceRefresh,
        valuation,
      );
      const tokenPath = jest.spyOn(valuation.service, 'getValuationHoldings');
      const restPath = jest.spyOn(valuation.service, 'getValuation');

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL)] });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      await service.recalculate();

      // No access token exists anywhere in this path: holdings come only from
      // the trusted internal reader.
      expect(tokenPath).not.toHaveBeenCalled();
      expect(restPath).not.toHaveBeenCalled();
    });

    it('makes no provider call of its own while valuing', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const valuation = makeValuation();
      const { service } = makeService(
        registry,
        holdings,
        priceRefresh,
        valuation,
      );

      stubHoldings(holdings, { [PORTFOLIO_1]: [holding(AAPL)] });
      stubPrices(priceRefresh, { [AAPL]: '150' });

      await service.recalculate();

      // The cycle priced AAPL once, through the refresh service; the valuation
      // step reused that Decimal instead of quoting again.
      expect(valuation.market.getQuotes).not.toHaveBeenCalled();
    });

    it('returns sanitized failures with no raw error or database detail', async () => {
      const registry = makeRegistry([identity(USER_A, PORTFOLIO_1)]);
      const holdings = makeHoldings();
      const priceRefresh = makePriceRefresh();
      const { service } = makeService(registry, holdings, priceRefresh);

      stubHoldings(holdings, {
        [PORTFOLIO_1]: new Error(
          'connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432',
        ),
      });
      stubPrices(priceRefresh, {});

      const result = await service.recalculate();
      const failure = result.results[0];

      expect(failure).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
      // A closed shape: no error object, no message, no cause.
      expect(Object.keys(failure).sort()).toEqual([
        'code',
        'ok',
        'portfolioId',
        'unpricedSymbols',
        'userId',
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('db.internal');
      expect(serialized).not.toContain('ECONNREFUSED');
    });

    it('keeps the service surface to its cycle and private helpers', async () => {
      const members = Object.getOwnPropertyNames(
        RealtimeRecalculationService.prototype,
      ).filter((member) => member !== 'constructor');

      expect(members.sort()).toEqual([
        'recalculate',
        'runCycle',
        'valuePortfolio',
      ]);
    });
  });
});
