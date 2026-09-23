import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGateway } from './portfolio.gateway';
import { RealtimePriceRefreshService } from './realtime-price-refresh.service';
import { RealtimeRecalculationScheduler } from './realtime-recalculation-scheduler.service';
import { RealtimeRecalculationService } from './realtime-recalculation.service';
import { RealtimeSubscriptionService } from './realtime-subscription.service';

/**
 * Real-time layer of AlphaPulse.
 *
 * `RealtimeSubscriptionService` is the centralized subscription registry and
 * lifecycle state machine (pending/active attempts, active portfolios and their
 * symbol snapshots, per-socket disconnect cleanup). `PortfolioGateway` owns the
 * transport: handshake authentication, payload validation, rooms, the one
 * initial valuation per subscribe, acknowledgements, and error mapping — it
 * delegates every subscription state change to the registry.
 * `RealtimePriceRefreshService` prices the registry's active symbols once per
 * cycle; nothing schedules it yet.
 *
 * `RealtimeRecalculationService` composes the three: it snapshots the active
 * portfolio identities, loads each portfolio's holdings through
 * `InternalHoldingsService` (the service-role reader, which is why
 * `PortfoliosModule` exports it), prices the union of those holdings once
 * through `RealtimePriceRefreshService`, and values every portfolio from that
 * one shared price map with `PortfoliosValuationService`. It computes and
 * returns; it schedules and broadcasts nothing.
 *
 * `RealtimeRecalculationScheduler` is the lifecycle owner: it drives that cycle
 * on a recursive timer (`REALTIME_REFRESH_INTERVAL_MS`, 60000ms by default),
 * skips entirely while no portfolio is active, and publishes each completed
 * result through `PortfolioGateway` — a `portfolio:valuation` to the portfolio's
 * room, or a sanitized `portfolio:error`. It starts with the module and stops
 * with it.
 *
 * Both services reuse `AuthService` (handshake token verification) and
 * `PortfoliosValuationService` (authorization + exact-decimal valuation) from
 * their existing modules. `MarketModule` supplies the exported `MarketService`
 * the refresh cycle prices symbols with — the dependency runs one way
 * (realtime → market), so no module cycle is introduced: RealtimeModule depends
 * on PortfoliosModule, never the reverse.
 */
@Module({
  imports: [AuthModule, PortfoliosModule, MarketModule],
  providers: [
    RealtimeSubscriptionService,
    RealtimePriceRefreshService,
    RealtimeRecalculationService,
    RealtimeRecalculationScheduler,
    PortfolioGateway,
  ],
})
export class RealtimeModule {}
