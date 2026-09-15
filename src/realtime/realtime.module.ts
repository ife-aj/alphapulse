import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGateway } from './portfolio.gateway';
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
 *
 * Both services reuse `AuthService` (handshake token verification) and
 * `PortfoliosValuationService` (authorization + exact-decimal valuation) from
 * their existing modules.
 */
@Module({
  imports: [AuthModule, PortfoliosModule],
  providers: [RealtimeSubscriptionService, PortfolioGateway],
})
export class RealtimeModule {}
