import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PortfolioGateway } from './portfolio.gateway';
import { RealtimeRecalculationService } from './realtime-recalculation.service';
import { RealtimeSubscriptionService } from './realtime-subscription.service';
import {
  recalculationSocketError,
  type PortfolioRecalculationFailure,
  type PortfolioRecalculationResult,
  type PortfolioValuationEvent,
} from './realtime.types';

/**
 * Cadence used when `REALTIME_REFRESH_INTERVAL_MS` is not configured.
 *
 * A minute is slow enough that a handful of connected users cannot hammer the
 * market provider, and fast enough that a live portfolio still looks live.
 */
export const DEFAULT_REALTIME_REFRESH_INTERVAL_MS = 60000;

/**
 * Read the configured cadence, falling back to the default for anything that is
 * not a positive number.
 *
 * `validateEnv` already rejects a malformed value at startup, so this is the
 * same defence `MarketModule` applies to its provider timeout: a module
 * compiled without that guard (an isolated test, a future embedder) must not
 * arm a timer that fires immediately in a tight loop.
 */
function refreshIntervalMs(config: ConfigService): number {
  const raw = Number(
    config.get<string>('REALTIME_REFRESH_INTERVAL_MS') ??
      DEFAULT_REALTIME_REFRESH_INTERVAL_MS,
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_REALTIME_REFRESH_INTERVAL_MS;
}

/**
 * Drives the realtime recalculation cycle on a timer and publishes its results.
 *
 * This is the slice that makes the pipeline live: it owns *when* a cycle runs,
 * and it turns a finished cycle into socket traffic. It computes nothing
 * itself — the cycle, the prices, and the valuations all belong to
 * `RealtimeRecalculationService`, and the transport belongs to
 * `PortfolioGateway`.
 *
 * Scheduling is deliberately a recursive `setTimeout` armed only after the
 * previous cycle has settled, never a `setInterval`. An interval fires on a
 * fixed cadence whether or not the work finished, so a cycle slower than the
 * interval would stack up behind itself — duplicate provider load and
 * out-of-order publications. Rescheduling afterwards makes overlap impossible
 * by construction: at most one cycle exists, and the next one is armed only
 * once the last one is done.
 *
 * With no active portfolios the cycle is skipped entirely: no database read, no
 * provider call, no work. An idle server costs one timer tick per interval.
 *
 * Publication rules:
 *  - One emit per portfolio *room*, never one per socket — Socket.IO fans the
 *    single call out to every socket watching that portfolio.
 *  - A result is published only if the portfolio is still the same activation
 *    the cycle computed for, so a subscriber that left (or left and returned)
 *    during the cycle is not handed a valuation from before their subscription.
 *  - A failed portfolio is reported as the socket contract's sanitized error,
 *    carrying a fixed message and a closed code — never the exception, the
 *    provider response, or a database message.
 *
 * A failure of the cycle *itself* is caught and logged, and the next cycle is
 * armed anyway: the poller must survive a transient outage rather than go
 * quietly dead.
 */
@Injectable()
export class RealtimeRecalculationScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeRecalculationScheduler.name);
  private readonly intervalMs: number;

  /** The pending tick, or null when nothing is scheduled. */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * False until the module initializes and again after it is destroyed. A cycle
   * that finishes after shutdown must not arm another timer.
   */
  private active = false;

  constructor(
    config: ConfigService,
    private readonly registry: RealtimeSubscriptionService,
    private readonly recalculation: RealtimeRecalculationService,
    private readonly gateway: PortfolioGateway,
  ) {
    this.intervalMs = refreshIntervalMs(config);
  }

  /** Arm the poller. The first cycle runs one full interval from now. */
  onModuleInit(): void {
    this.active = true;
    this.scheduleNext();
    this.logger.log(
      `Realtime recalculation scheduled every ${this.intervalMs}ms`,
    );
  }

  /**
   * Stop cleanly: no further cycle is armed, and a pending tick is cancelled so
   * the timer cannot hold the process open. A cycle already in flight finishes
   * — it publishes nothing further, because `active` is now false and the
   * registry's activations are gone with their sockets — and its `finally`
   * finds nothing to reschedule.
   */
  onModuleDestroy(): void {
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.active) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  /**
   * One scheduled tick. The timer handle is cleared first, so the cycle is
   * never mistaken for a scheduled one, and the next tick is armed in `finally`
   * whether the cycle succeeded, failed, or skipped.
   */
  private async runCycle(): Promise<void> {
    this.timer = null;
    try {
      await this.recalculateAndBroadcast();
    } catch (error) {
      this.logCycleFailure(error);
    } finally {
      this.scheduleNext();
    }
  }

  private async recalculateAndBroadcast(): Promise<void> {
    // Idle guard, checked before the cycle so an idle server does no work at
    // all. A portfolio that subscribes during the cycle is served by the next
    // one — it has already received its subscribe-time valuation.
    if (this.registry.getActivePortfolioIdentities().length === 0) {
      return;
    }

    const result = await this.recalculation.recalculate();
    for (const entry of result.results) {
      this.publish(entry);
    }
  }

  /**
   * Publish one portfolio's outcome, if it still belongs to someone.
   *
   * The activation check is the stale-result guard: the cycle captured a
   * `revision` when it snapshotted this portfolio, and a subscription that
   * ended — or ended and began again — during the cycle no longer matches it.
   * Identity alone would not be enough, because a resubscribed portfolio is
   * active again under the same `(userId, portfolioId)`; the revision is what
   * distinguishes the subscription that replaced the one the cycle ran for.
   */
  private publish(entry: PortfolioRecalculationResult): void {
    if (
      !this.registry.isActivePortfolio(
        entry.userId,
        entry.portfolioId,
        entry.revision,
      )
    ) {
      return;
    }

    if (entry.ok) {
      const event: PortfolioValuationEvent = {
        portfolioId: entry.portfolioId,
        emittedAt: new Date().toISOString(),
        valuation: entry.valuation,
      };
      this.gateway.broadcastValuation(entry.userId, entry.portfolioId, event);
      return;
    }

    this.gateway.broadcastPortfolioError(
      entry.userId,
      entry.portfolioId,
      recalculationSocketError(entry.code),
    );
    this.logPortfolioFailure(entry);
  }

  /**
   * Log a portfolio failure with the classification and the ids the server
   * already knows, and nothing else. The result's closed code is precisely what
   * makes this line safe: there is no exception here to leak a PostgREST
   * message, a provider payload, or a credential-bearing URL.
   */
  private logPortfolioFailure(entry: PortfolioRecalculationFailure): void {
    const unpriced =
      entry.unpricedSymbols.length > 0
        ? `, unpriced: ${entry.unpricedSymbols.join(',')}`
        : '';
    const context = `Recalculation failed for portfolio ${entry.portfolioId} (${entry.code}${unpriced})`;

    if (entry.code === 'PORTFOLIO_NOT_FOUND') {
      // The portfolio is gone; that is an outcome, not a fault.
      this.logger.debug(context);
    } else if (entry.code === 'MISSING_PRICE') {
      this.logger.warn(context);
    } else {
      this.logger.error(context);
    }
  }

  /**
   * Log a failure of the cycle itself. Only the error's type and HTTP status
   * are recorded — never its message, which can carry a PostgREST error object
   * or raw Axios internals. Matches the level convention used by
   * `RealtimePriceRefreshService` for the same reason.
   */
  private logCycleFailure(error: unknown): void {
    const name = error instanceof Error ? error.name : typeof error;
    const status =
      error instanceof HttpException ? `, http ${error.getStatus()}` : '';
    this.logger.error(`Recalculation cycle failed (${name}${status})`);
  }
}
