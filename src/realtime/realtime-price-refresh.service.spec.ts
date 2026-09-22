import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { MarketService } from '../market/market.service';
import type { Quote } from '../market/market.types';
import type { RealtimeSubscriptionService } from './realtime-subscription.service';
import {
  REFRESH_QUOTE_CONCURRENCY,
  RealtimePriceRefreshService,
} from './realtime-price-refresh.service';

/**
 * Refresh-cycle unit tests over the real `RealtimePriceRefreshService`, with a
 * scripted registry snapshot and a scripted market stub. Deterministic deferred
 * promises (never arbitrary sleeps) drive every concurrency and overlap case.
 */

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

/** A quote object in the provider's response shape. */
function quote(symbol: string, price: number): Quote {
  return { symbol, price, change: 0, changePercent: 0, timestamp: '0' };
}

function makeRegistry(symbols: string[] = []) {
  return { getActiveSymbols: jest.fn((): string[] => [...symbols]) };
}

type RegistryStub = ReturnType<typeof makeRegistry>;

function makeMarket() {
  return { getQuotes: jest.fn() };
}

type MarketStub = ReturnType<typeof makeMarket>;

function makeService(registry = makeRegistry(), market = makeMarket()) {
  return {
    registry,
    market,
    service: new RealtimePriceRefreshService(
      registry as unknown as RealtimeSubscriptionService,
      market as unknown as MarketService,
    ),
  };
}

/** Script one successful quote per requested symbol, all at the same price. */
function stubPrices(market: MarketStub, price = 100): void {
  market.getQuotes.mockImplementation((symbols: string[]) =>
    Promise.resolve(symbols.map((symbol) => quote(symbol, price))),
  );
}

/** Script a per-symbol response; a value is either quotes or a rejection. */
function stubPerSymbol(
  market: MarketStub,
  bySymbol: Record<string, Quote[] | Error>,
): void {
  market.getQuotes.mockImplementation((symbols: string[]) => {
    const response = bySymbol[symbols[0]];
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  });
}

/** The single symbol requested on each `getQuotes` call, in call order. */
function requestedSymbols(market: MarketStub): string[] {
  return market.getQuotes.mock.calls.map(
    (call: unknown[]) => (call[0] as string[])[0],
  );
}

describe('RealtimePriceRefreshService', () => {
  describe('symbol snapshot', () => {
    it('makes no market calls at all for an empty registry', async () => {
      const { market, service } = makeService();

      const result = await service.refresh();

      expect(market.getQuotes).not.toHaveBeenCalled();
      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([]);
    });

    it('fetches each unique symbol exactly once per cycle', async () => {
      const { registry, market, service } = makeService();
      // The registry reports one entry per requiring portfolio: five symbols,
      // two of them distinct.
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT, AAPL, MSFT, AAPL]);
      stubPrices(market);

      const result = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(2);
      expect(requestedSymbols(market)).toEqual([AAPL, MSFT]);
      expect(market.getQuotes).toHaveBeenCalledWith([AAPL]);
      expect(market.getQuotes).toHaveBeenCalledWith([MSFT]);
      expect([...result.prices.keys()]).toEqual([AAPL, MSFT]);
      expect(result.failedSymbols).toEqual([]);
    });

    it('normalizes and deduplicates the snapshot defensively', async () => {
      const { registry, market, service } = makeService();
      // The registry stores normalized symbols, but a cycle must not depend on
      // that: casing and surrounding whitespace collapse to one fetch.
      registry.getActiveSymbols.mockReturnValue([` ${AAPL} `, 'aapl', AAPL]);
      stubPrices(market);

      const result = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(1);
      expect(market.getQuotes).toHaveBeenCalledWith([AAPL]);
      expect([...result.prices.keys()]).toEqual([AAPL]);
    });

    it('orders symbols deterministically regardless of snapshot order', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([TSLA, MSFT, AAPL]);
      stubPrices(market);

      const result = await service.refresh();

      // Fetch order, map insertion order, and (below) the failure list all
      // follow the same sorted order, never the registry's insertion order.
      expect(requestedSymbols(market)).toEqual([AAPL, MSFT, TSLA]);
      expect([...result.prices.keys()]).toEqual([AAPL, MSFT, TSLA]);
      expect(result.failedSymbols).toEqual([]);
    });

    it('ignores blank symbols rather than sending them upstream', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue(['', '   ', AAPL]);
      stubPrices(market);

      const result = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(1);
      expect(market.getQuotes).toHaveBeenCalledWith([AAPL]);
      expect([...result.prices.keys()]).toEqual([AAPL]);
    });

    it('snapshots at cycle start, so registry changes wait for the next cycle', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValueOnce([AAPL]);
      const gate = deferred<Quote[]>();
      market.getQuotes.mockReturnValue(gate.promise);

      const cycle = service.refresh();
      await flush();

      // The registry gains a symbol while the cycle is still running.
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT]);

      gate.resolve([quote(AAPL, 100)]);
      const result = await cycle;

      // The in-flight cycle is untouched: MSFT is never fetched here.
      expect(market.getQuotes).toHaveBeenCalledTimes(1);
      expect([...result.prices.keys()]).toEqual([AAPL]);

      // The next cycle picks up the new snapshot.
      stubPrices(market);
      const next = await service.refresh();
      expect(requestedSymbols(market).slice(1)).toEqual([AAPL, MSFT]);
      expect([...next.prices.keys()]).toEqual([AAPL, MSFT]);
    });
  });

  describe('partial failure', () => {
    it('keeps the successful prices when one symbol fails', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT, TSLA]);
      stubPerSymbol(market, {
        [AAPL]: [quote(AAPL, 100)],
        [MSFT]: new ServiceUnavailableException('provider down'),
        [TSLA]: [quote(TSLA, 300)],
      });

      const result = await service.refresh();

      expect([...result.prices.keys()]).toEqual([AAPL, TSLA]);
      expect(result.prices.get(AAPL)?.toString()).toBe('100');
      expect(result.prices.get(TSLA)?.toString()).toBe('300');
      expect(result.failedSymbols).toEqual([MSFT]);
    });

    it('resolves with an empty map when every symbol fails', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT]);
      stubPerSymbol(market, {
        [AAPL]: new NotFoundException('no market data'),
        [MSFT]: new ServiceUnavailableException('provider down'),
      });

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL, MSFT]);
    });

    it('reports failures in deterministic symbol order', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([TSLA, MSFT, AAPL]);
      stubPerSymbol(market, {
        [AAPL]: new NotFoundException('no market data'),
        [MSFT]: new NotFoundException('no market data'),
        [TSLA]: [quote(TSLA, 300)],
      });

      const result = await service.refresh();

      expect(result.failedSymbols).toEqual([AAPL, MSFT]);
    });
  });

  describe('quote validation', () => {
    it('rejects an empty quote array', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([]);

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL]);
    });

    it('rejects multiple quotes returned for a one-symbol request', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([quote(AAPL, 100), quote(AAPL, 200)]);

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL]);
    });

    it('rejects a quote whose symbol does not match the request', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([quote(MSFT, 100)]);

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL]);
    });

    it('rejects a malformed quote row', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([null]);

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL]);
    });

    it('accepts a provider symbol that only differs by case', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([quote('aapl', 100)]);

      const result = await service.refresh();

      expect(result.prices.get(AAPL)?.toString()).toBe('100');
      expect(result.failedSymbols).toEqual([]);
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['positive Infinity', Number.POSITIVE_INFINITY],
      ['negative Infinity', Number.NEGATIVE_INFINITY],
      ['a string', '100'],
    ])('treats a %s price as that symbol failing', async (_label, price) => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      // The symbol matches, so only the price is under test — and a zero must
      // never be substituted for a real price.
      market.getQuotes.mockResolvedValue([
        quote(AAPL, price as unknown as number),
      ]);

      const result = await service.refresh();

      expect(result.prices.size).toBe(0);
      expect(result.failedSymbols).toEqual([AAPL]);
    });

    it('converts the price to an exact Decimal exactly once', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      market.getQuotes.mockResolvedValue([quote(AAPL, 182.7465)]);

      const result = await service.refresh();
      const price = result.prices.get(AAPL);

      expect(price).toBeInstanceOf(Decimal);
      expect(price?.toString()).toBe('182.7465');
      expect(price?.equals(new Decimal('182.7465'))).toBe(true);
    });
  });

  describe('concurrency bound', () => {
    it('never runs more than the configured quote fetches concurrently', async () => {
      const symbols = [
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
        'G',
        'H',
        'I',
        'J',
        'K',
        'L',
      ];
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue(symbols);

      const gates = new Map<string, ReturnType<typeof deferred<Quote[]>>>();
      let inFlight = 0;
      let peak = 0;
      market.getQuotes.mockImplementation((requested: string[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const gate = deferred<Quote[]>();
        gates.set(requested[0], gate);
        return gate.promise.finally(() => {
          inFlight -= 1;
        });
      });

      const cycle = service.refresh();
      await flush();

      // Exactly the bound's worth of fetches started, no more.
      expect(peak).toBe(REFRESH_QUOTE_CONCURRENCY);
      expect([...gates.keys()]).toEqual(['A', 'B', 'C', 'D', 'E']);

      // Releasing one admits exactly one more, never two.
      for (const symbol of symbols) {
        const gate = gates.get(symbol);
        if (gate === undefined) {
          throw new Error(`expected a pending fetch for ${symbol}`);
        }
        gate.resolve([quote(symbol, 1)]);
        await flush();
        expect(peak).toBe(REFRESH_QUOTE_CONCURRENCY);
      }

      const result = await cycle;
      expect(result.prices.size).toBe(symbols.length);
      expect(result.failedSymbols).toEqual([]);
    });
  });

  describe('overlapping cycles', () => {
    it('coalesces concurrent calls into a single cycle', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      const gate = deferred<Quote[]>();
      market.getQuotes.mockReturnValue(gate.promise);

      const first = service.refresh();
      const second = service.refresh();
      await flush();

      // Concurrent callers share the one running cycle: one provider request,
      // and the identical promise object (refresh is deliberately not `async`).
      expect(second).toBe(first);
      expect(market.getQuotes).toHaveBeenCalledTimes(1);

      gate.resolve([quote(AAPL, 100)]);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toBe(secondResult);
      expect(firstResult.prices.get(AAPL)?.toString()).toBe('100');
      expect(market.getQuotes).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of calls without duplicating any symbol', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT]);
      const gate = deferred<Quote[]>();
      market.getQuotes.mockReturnValue(gate.promise);

      const cycles = [service.refresh(), service.refresh(), service.refresh()];
      await flush();
      expect(market.getQuotes).toHaveBeenCalledTimes(2);

      gate.resolve([quote(AAPL, 100)]);
      await Promise.all(cycles);

      expect(requestedSymbols(market)).toEqual([AAPL, MSFT]);
    });

    it('starts a new cycle for a call made after completion', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      stubPrices(market);

      await service.refresh();
      expect(market.getQuotes).toHaveBeenCalledTimes(1);

      const second = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(2);
      expect(second.prices.get(AAPL)?.toString()).toBe('100');
    });

    it('clears the in-flight guard after an all-failure cycle', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL]);
      stubPerSymbol(market, {
        [AAPL]: new ServiceUnavailableException('provider down'),
      });

      const failedCycle = await service.refresh();
      expect(failedCycle.prices.size).toBe(0);
      expect(failedCycle.failedSymbols).toEqual([AAPL]);

      // The guard recovered, so the next cycle runs and can succeed.
      stubPrices(market, 250);
      const next = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(2);
      expect(next.prices.get(AAPL)?.toString()).toBe('250');
      expect(next.failedSymbols).toEqual([]);
    });

    it('clears the in-flight guard after a partially failing cycle', async () => {
      const { registry, market, service } = makeService();
      registry.getActiveSymbols.mockReturnValue([AAPL, MSFT]);
      stubPerSymbol(market, {
        [AAPL]: [quote(AAPL, 100)],
        [MSFT]: new ServiceUnavailableException('provider down'),
      });

      const partial = await service.refresh();
      expect(partial.failedSymbols).toEqual([MSFT]);

      stubPrices(market, 250);
      const next = await service.refresh();

      expect(market.getQuotes).toHaveBeenCalledTimes(4);
      expect([...next.prices.keys()]).toEqual([AAPL, MSFT]);
      expect(next.failedSymbols).toEqual([]);
    });
  });
});
