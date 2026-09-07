import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGateway } from './portfolio.gateway';

/**
 * Real-time layer of AlphaPulse.
 *
 * Slice 1 exposes one authenticated Socket.IO gateway (`PortfolioGateway`)
 * that delivers a single initial valuation per `portfolio:subscribe`. The
 * gateway reuses `AuthService` (handshake token verification) and
 * `PortfoliosValuationService` (authorization + exact-decimal valuation) from
 * their existing modules — no new business logic lives here yet.
 */
@Module({
  imports: [AuthModule, PortfoliosModule],
  providers: [PortfolioGateway],
})
export class RealtimeModule {}
