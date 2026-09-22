import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { InternalHoldingsService } from './internal-holdings.service';
import { PortfoliosValuationService } from './portfolio-valuation.service';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';

/**
 * Authenticated portfolio CRUD, holdings, and live valuation.
 *
 * Needs MarketModule only for its exported MarketService (used by the read-only
 * valuation service to fetch live quotes).
 *
 * `InternalHoldingsService` is registered here because holdings are this module's
 * domain, but it is deliberately NOT exported: nothing consumes it yet, and
 * keeping it module-private means no other module can reach the privileged
 * reader until Slice 3B.2 introduces its consumer (the realtime recalculation
 * coordinator) and exports it then.
 */
@Module({
  imports: [SupabaseModule, AuthModule, MarketModule],
  controllers: [PortfoliosController],
  providers: [
    PortfoliosService,
    PortfoliosValuationService,
    InternalHoldingsService,
  ],
  // RealtimeModule reuses getValuation (authorization + exact-decimal
  // valuation) for the authenticated live socket.
  exports: [PortfoliosValuationService],
})
export class PortfoliosModule {}
