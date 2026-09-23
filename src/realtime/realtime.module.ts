import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGateway } from './portfolio.gateway';
import { RealtimePriceRefreshService } from './realtime-price-refresh.service';
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
 * one shared price map with `PortfoliosValuationService`. It is timer-free and
 * broadcast-free: it computes and returns, and nothing schedules it yet.
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
    PortfolioGateway,
  ],
})
export class RealtimeModule {}
