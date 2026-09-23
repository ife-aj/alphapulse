import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { normalizeSymbol } from '../market/validation/symbol.validation';
import { InternalHoldingsService } from '../portfolios/internal-holdings.service';
import { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import type { ValuationHolding } from '../portfolios/valuation-computation';
import { RealtimePriceRefreshService } from './realtime-price-refresh.service';
import { RealtimeSubscriptionService } from './realtime-subscription.service';
import { settleWithConcurrency } from './settle-concurrency';
import type {
  ActivePortfolioIdentity,
  PortfolioRecalculationFailure,
  PortfolioRecalculationFailureCode,
  PortfolioRecalculationResult,
  RealtimeRecalculationResult,
  SymbolPriceMap,
} from './realtime.types';

/**
 * How many portfolio holdings reads one recalculation cycle may have in flight
 * at once. Mirrors the quote bounds (`VALUATION_QUOTE_CONCURRENCY`,
 * `REFRESH_QUOTE_CONCURRENCY`) so a cycle puts a bounded load on Supabase no
 * matter how many portfolios are active — an unbounded fan-out over the
 * registry would be a self-inflicted denial of service.
 */
export const RECALCULATION_PORTFOLIO_CONCURRENCY = 5;

/**
 * The normalized, deduplicated, sorted symbols of every holdings read that
 * succeeded.
 *
 * `symbols` is not consulted: the set of prices a cycle needs is exactly the
 * set of symbols its holdings actually contain. Taking it from the registry
 * instead would go stale the moment a holding is added or removed over REST —
 * the registry's snapshot is only refreshed by a successful subscribe, and a
 * re-subscribe of a live subscription short-circuits as a duplicate.
 *
 * A failed read contributes nothing: its portfolio fails below, so its symbols
 * must not cost provider calls. Blank symbols are dropped rather than sent
 * upstream. Sorted, so fetch order and the resulting map are independent of
 * subscription history.
 */
function uniqueSortedSymbols(
  loaded: readonly PromiseSettledResult<readonly ValuationHolding[]>[],
): string[] {
  const symbols = new Set<string>();
  for (const settled of loaded) {
    if (settled.status !== 'fulfilled') {
      continue;
    }
    for (const holding of settled.value) {
      const symbol = normalizeSymbol(holding.symbol);
      if (symbol.length > 0) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols].sort();
}

/**
 * The normalized, deduplicated, sorted symbols these holdings need but the
 * cycle's shared price map does not contain. Empty means every holding can be
 * valued exactly.
 */
function missingPrices(
  holdings: readonly ValuationHolding[],
  prices: SymbolPriceMap,
): string[] {
  const missing = new Set<string>();
  for (const holding of holdings) {
    const symbol = normalizeSymbol(holding.symbol);
    if (!prices.has(symbol)) {
      missing.add(symbol);
    }
  }
  return [...missing].sort();
}

/**
 * Map a thrown failure onto the closed result vocabulary and discard the
 * exception itself.
 *
 * Results are the output a later slice will broadcast or log, so a raw
 * exception — which can carry a PostgREST message, a provider payload, or a
 * credential-bearing URL — must never travel with them. Only the classification
 * does; the detail stays server-side, where the existing services already log
 * it.
 */
function classify(error: unknown): PortfolioRecalculationFailureCode {
  if (!(error instanceof HttpException)) {
    return 'INTERNAL_ERROR';
  }
  const status = error.getStatus();
  if (status === HttpStatus.NOT_FOUND) {
    // The neutral 404: the portfolio is gone, or was never this user's.
    return 'PORTFOLIO_NOT_FOUND';
  }
  if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
    // The valuation path's "no usable market data for this symbol".
    return 'MISSING_PRICE';
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS) {
    return 'HOLDINGS_UNAVAILABLE';
  }
  return status >= 500 ? 'HOLDINGS_UNAVAILABLE' : 'INTERNAL_ERROR';
}

function failure(
  identity: ActivePortfolioIdentity,
  code: PortfolioRecalculationFailureCode,
  unpricedSymbols: string[],
): PortfolioRecalculationFailure {
  return {
    ok: false,
    userId: identity.userId,
    portfolioId: identity.portfolioId,
    code,
    unpricedSymbols,
  };
}

/**
 * One recalculation cycle: active portfolio identities → fresh holdings →
 * one shared price snapshot → a valuation per portfolio.
 *
 * The order matters, and each step exists for a reason:
 *
 *  1. Snapshot the registry's active identities, synchronously, before the
 *     first await. A subscription change made while the cycle runs belongs to
 *     the next cycle; the cycle never re-reads the registry mid-flight.
 *  2. Load each portfolio's holdings from the database through the trusted
 *     internal reader — never through a user access token, which the registry
 *     deliberately does not hold and which expires. Isolation is per portfolio:
 *     one unreadable portfolio must not discard the others.
 *  3. Price the union of what those holdings actually contain, once per unique
 *     symbol, and reuse that one price for every portfolio holding it.
 *  4. Value each portfolio from that same map. A portfolio holding a symbol the
 *     cycle could not price fails **atomically** for this cycle — it is never
 *     valued over a zero, a skipped line, or a stale price, because a total
 *     computed that way is silently wrong and money must not be.
 *
 * Coalesced like the price cycle it builds on: overlapping triggers share the
 * one running cycle rather than starting a second, so a symbol is still fetched
 * at most once per completed cycle and two cycles can never publish
 * out-of-order results. This service is timer-free, broadcast-free, and retains
 * nothing between cycles — it computes and returns.
 *
 * Credential boundary: nothing here accepts, holds, or returns an access token,
 * a Supabase client, a raw exception, or a provider payload. The only privileged
 * access is the internal reader's, whose ownership check remains userId +
 * portfolioId on every read.
 */
@Injectable()
export class RealtimeRecalculationService {
  /** The running cycle, shared by every concurrent caller. Null while idle. */
  private inFlight: Promise<RealtimeRecalculationResult> | null = null;

  constructor(
    private readonly registry: RealtimeSubscriptionService,
    private readonly internalHoldings: InternalHoldingsService,
    private readonly priceRefresh: RealtimePriceRefreshService,
    private readonly valuation: PortfoliosValuationService,
  ) {}

  /**
   * Recompute every active portfolio's valuation from one shared price
   * snapshot.
   *
   * Concurrent calls are coalesced: while a cycle is running, every caller
   * receives that same cycle rather than starting a second one.
   *
   * Deliberately *not* `async`. The stored cycle promise is returned directly
   * so coalesced callers receive the identical object rather than a fresh
   * wrapper around it; declaring this `async` would silently break that
   * identity.
   */
  recalculate(): Promise<RealtimeRecalculationResult> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    // The guard clears as soon as the cycle settles — every portfolio
    // succeeding, partially failing, or failing outright — so a later call
    // starts a fresh cycle. Clearing inside `finally` is what makes the service
    // self-healing after a bad cycle.
    const cycle = this.runCycle().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async runCycle(): Promise<RealtimeRecalculationResult> {
    // Step 1 — the starting snapshot. `getActivePortfolioIdentities` returns a
    // fresh sorted array, so a subscribe/unsubscribe made while this cycle runs
    // cannot mutate the set being processed.
    const identities = this.registry.getActivePortfolioIdentities();

    // Step 2 — fresh holdings, bounded and isolated per portfolio. Settlement
    // preserves input order, so `loaded[index]` is always `identities[index]`.
    const loaded = await settleWithConcurrency(
      identities,
      RECALCULATION_PORTFOLIO_CONCURRENCY,
      (identity) =>
        this.internalHoldings.getInternalValuationHoldings(
          identity.userId,
          identity.portfolioId,
        ),
    );

    // Step 3 — one price per unique symbol the successful reads returned.
    const { prices, failedSymbols } = await this.priceRefresh.priceSymbols(
      uniqueSortedSymbols(loaded),
    );

    // Step 4 — value each portfolio from that one shared map, in snapshot
    // order. Every failure is a result value, never an error escaping the
    // cycle, so one bad portfolio cannot discard the others.
    const results: PortfolioRecalculationResult[] = [];
    loaded.forEach((settled, index) => {
      const identity = identities[index];
      if (settled.status !== 'fulfilled') {
        // The holdings read failed, so this portfolio's symbols are unknown and
        // must not be reported as unpriced.
        results.push(failure(identity, classify(settled.reason), []));
        return;
      }
      results.push(this.valuePortfolio(identity, settled.value, prices));
    });

    return { prices, failedSymbols, results };
  }

  /**
   * Value one portfolio against the cycle's shared prices, or fail it
   * atomically.
   *
   * The missing-price check runs before the valuation so the failure can name
   * the exact symbols; `valueHoldingsWithPrices` independently refuses to value
   * over a missing price, so the invariant holds even if this pre-check is ever
   * bypassed.
   *
   * An owned portfolio with no holdings is a valid portfolio: it yields the
   * exact zero valuation and contributes no symbols to price. An empty holding
   * list is never conflated with a failed read — a failed read is the branch
   * above, and reporting it as an empty portfolio would publish a zero total
   * for a portfolio that may hold anything.
   */
  private valuePortfolio(
    identity: ActivePortfolioIdentity,
    holdings: readonly ValuationHolding[],
    prices: SymbolPriceMap,
  ): PortfolioRecalculationResult {
    const unpricedSymbols = missingPrices(holdings, prices);
    if (unpricedSymbols.length > 0) {
      return failure(identity, 'MISSING_PRICE', unpricedSymbols);
    }

    try {
      return {
        ok: true,
        userId: identity.userId,
        portfolioId: identity.portfolioId,
        valuation: this.valuation.valueHoldingsWithPrices(
          identity.portfolioId,
          holdings,
          prices,
        ),
      };
    } catch (error) {
      // Defensive: the pre-check above should already have caught every
      // missing price. Classification only — the exception itself never leaves.
      return failure(identity, classify(error), []);
    }
  }
}
