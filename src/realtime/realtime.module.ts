import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGateway } from './portfolio.gateway';
import { RealtimePriceRefreshService } from './realtime-price-refresh.service';
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
 * Both services reuse `AuthService` (handshake token verification) and
 * `PortfoliosValuationService` (authorization + exact-decimal valuation) from
 * their existing modules. `MarketModule` supplies the exported `MarketService`
 * the refresh cycle prices symbols with — the dependency runs one way
 * (realtime → market), so no module cycle is introduced.
 */
@Module({
  imports: [AuthModule, PortfoliosModule, MarketModule],
  providers: [
    RealtimeSubscriptionService,
    RealtimePriceRefreshService,
    PortfolioGateway,
  ],
})
export class RealtimeModule {}
