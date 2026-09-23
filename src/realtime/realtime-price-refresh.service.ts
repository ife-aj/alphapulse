import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { MarketService } from '../market/market.service';
import { normalizeSymbol } from '../market/validation/symbol.validation';
import { RealtimeSubscriptionService } from './realtime-subscription.service';
import { settleWithConcurrency } from './settle-concurrency';
import type {
  RealtimePriceRefreshResult,
  SymbolPriceMap,
} from './realtime.types';

/**
 * How many quote requests one refresh cycle may have in flight at once. Mirrors
 * `VALUATION_QUOTE_CONCURRENCY` so a cycle and a REST valuation put the same
 * load on the provider; neither is allowed to fan out over an unbounded list.
 */
export const REFRESH_QUOTE_CONCURRENCY = 5;

/**
 * Marker for a provider response that cannot be attributed to the symbol we
 * requested. The message stays internal — `logSymbolFailure` never logs the
 * error object (see there), so it cannot leak a provider payload.
 */
function unusableQuote(): Error {
  return new Error('Quote response was not usable for the requested symbol.');
}

/**
 * Defensively normalize, deduplicate, and sort a registry symbol snapshot.
 *
 * The registry already stores normalized symbols, but a cycle must not depend on
 * that: normalizing here keeps "one provider call per unique symbol" true even
 * if a future caller hands over raw user input. Sorting makes the fetch order —
 * and therefore the result map and failure list — independent of subscription
 * history. Blank entries are dropped rather than sent upstream.
 */
function normalizeUniqueSorted(symbols: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const symbol of symbols) {
    const normalized = normalizeSymbol(symbol);
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }
  return [...unique].sort();
}

/**
 * One price-refresh cycle over the realtime registry's active symbols.
 *
 * The cycle is deliberately narrow:
 *
 *   active symbols → normalize/dedupe/sort → fetch each exactly once (bounded
 *   concurrency) → collect the prices that succeeded
 *
 * It prices symbols and nothing else. It does not load holdings, recompute a
 * portfolio, touch the registry, or emit anything — the registry is read once,
 * for its symbol snapshot, and a registry change made while a cycle is running
 * belongs to the *next* cycle. No timer drives it yet; callers invoke
 * `refresh()` (registry symbols) or `priceSymbols(symbols)` (an explicit set,
 * as the recalculation coordinator uses).
 *
 * Partial failure is the result shape, not an error path. One symbol the
 * provider cannot price never discards the prices that did arrive: the cycle
 * always resolves, reporting unpriced symbols in `failedSymbols`. A failed
 * symbol is omitted rather than defaulted, because a zero substituted for a real
 * price would silently corrupt every valuation built on it.
 *
 * Single-instance, in-memory state, consistent with this slice's Socket.IO
 * assumptions: one running cycle is shared process-wide.
 */
@Injectable()
export class RealtimePriceRefreshService {
  private readonly logger = new Logger(RealtimePriceRefreshService.name);

  /** The running cycle, shared by every concurrent caller. Null while idle. */
  private inFlight: Promise<RealtimePriceRefreshResult> | null = null;

  constructor(
    private readonly registry: RealtimeSubscriptionService,
    private readonly marketService: MarketService,
  ) {}

  /**
   * Fetch the live price of every unique symbol the registry currently requires.
   *
   * Concurrent calls are coalesced: while a cycle is running, every caller
   * receives that same cycle rather than starting a second one, so overlapping
   * triggers can never produce duplicate provider requests for a symbol.
   *
   * Deliberately *not* `async`. The stored cycle promise is returned directly so
   * coalesced callers receive the identical object rather than a fresh wrapper
   * around it; declaring this `async` would silently break that identity.
   */
  refresh(): Promise<RealtimePriceRefreshResult> {
    return this.coalesce(() =>
      this.priceSymbols(this.registry.getActiveSymbols()),
    );
  }

  /**
   * Price an explicit, caller-supplied symbol set.
   *
   * The same cycle `refresh()` runs — defensively normalize/dedupe/sort, fetch
   * each unique symbol exactly once under the shared concurrency bound, isolate
   * per-symbol failure, convert once to `Decimal` — over symbols the caller
   * already knows. A recalculation cycle uses this, because the symbols it must
   * price are derived from freshly loaded holdings, not from the registry's
   * snapshot: a holding added over REST after a socket subscribed is in the
   * database but not yet in the registry.
   *
   * Deliberately NOT coalesced. `refresh()` may coalesce because every caller
   * wants the same set — the registry's current symbols; here two callers could
   * legitimately want different sets, and handing one the other's prices would
   * be silently wrong. Callers that need overlap protection coalesce their own
   * unit of work (the recalculation coordinator coalesces the whole cycle).
   */
  priceSymbols(
    symbols: readonly string[],
  ): Promise<RealtimePriceRefreshResult> {
    return this.runCycle(symbols);
  }

  /**
   * Run one cycle, sharing an already-running one with concurrent callers so
   * overlapping triggers can never produce duplicate provider requests. The
   * stored promise is returned directly, so coalesced callers receive the
   * identical object rather than a fresh wrapper around it.
   */
  private coalesce(
    start: () => Promise<RealtimePriceRefreshResult>,
  ): Promise<RealtimePriceRefreshResult> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    // The guard clears as soon as the cycle settles — success, partial failure,
    // or all-failure alike — so a later call starts a fresh cycle. Clearing
    // inside `finally` is what makes the service self-healing after a bad cycle.
    const cycle = start().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async runCycle(
    requestedSymbols: readonly string[],
  ): Promise<RealtimePriceRefreshResult> {
    // The caller's list is snapshotted synchronously (callers pass a fresh array
    // — `getActiveSymbols` for the registry path), so a subscription made while
    // this cycle runs cannot mutate the set being fetched here; it is picked up
    // by the next cycle.
    const symbols = normalizeUniqueSorted(requestedSymbols);

    const settled = await settleWithConcurrency(
      symbols,
      REFRESH_QUOTE_CONCURRENCY,
      (symbol) => this.fetchPrice(symbol),
    );

    const prices = new Map<string, Decimal>();
    const failedSymbols: string[] = [];

    // Settlement preserves input order and `symbols` is sorted, so both the map
    // and the failure list come out in deterministic symbol order.
    settled.forEach((result, index) => {
      const symbol = symbols[index];
      if (result.status === 'fulfilled') {
        prices.set(symbol, result.value);
      } else {
        failedSymbols.push(symbol);
        this.logSymbolFailure(symbol, result.reason);
      }
    });

    return { prices, failedSymbols };
  }

  /**
   * Fetch the exact price for one symbol, or fail that symbol alone.
   *
   * A one-symbol request must come back with exactly one usable quote, carrying
   * the symbol we asked for and a finite price above zero. Anything else —
   * a missing, empty, malformed, or multi-row response, a quote for a different
   * symbol, or a zero/negative/non-finite price — is that symbol failing, never
   * a price to carry forward. A zero is never substituted for a real price.
   */
  private async fetchPrice(symbol: string): Promise<Decimal> {
    const quotes: unknown = await this.marketService.getQuotes([symbol]);

    // An empty or multi-row response cannot be attributed to `symbol`.
    if (!Array.isArray(quotes) || quotes.length !== 1) {
      throw unusableQuote();
    }

    const quote: unknown = quotes[0];
    if (typeof quote !== 'object' || quote === null) {
      throw unusableQuote();
    }

    const { symbol: quotedSymbol, price } = quote as {
      symbol?: unknown;
      price?: unknown;
    };

    // The provider echoes the symbol it priced. A mismatch means this price does
    // not belong to `symbol` and must never be used for it. Compared in
    // normalized form, so casing/whitespace from the provider is not a failure.
    if (
      typeof quotedSymbol !== 'string' ||
      normalizeSymbol(quotedSymbol) !== symbol
    ) {
      throw unusableQuote();
    }

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw unusableQuote();
    }

    // Converted exactly once, here at the market boundary, and reused by every
    // later phase — never re-derived from a rounded or re-parsed value.
    return new Decimal(price);
  }

  /**
   * Log one unpriced symbol with neutral context only: the symbol, and the
   * provider's HTTP status when the failure came from one. The error object is
   * never logged — it can carry the provider URL, an API key, or raw Axios
   * internals. Level matches the existing market convention: 404 (an expected
   * unknown symbol) → debug, 500 (credential/config problem) → error, anything
   * else (rate limit, timeout, malformed response) → warn.
   */
  private logSymbolFailure(symbol: string, reason: unknown): void {
    const status =
      reason instanceof HttpException ? reason.getStatus() : undefined;
    const detail = `Refresh cycle could not price ${symbol} (${
      status === undefined ? 'no provider status' : status
    })`;

    if (status === HttpStatus.NOT_FOUND) {
      this.logger.debug(detail);
    } else if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(detail);
    } else {
      this.logger.warn(detail);
    }
  }
}
