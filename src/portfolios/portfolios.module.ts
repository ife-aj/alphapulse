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
 * `InternalHoldingsService` is registered here because holdings are this
 * module's domain. It is exported for exactly one consumer — the realtime
 * recalculation coordinator, which must load holdings without a user access
 * token — so the privileged reader is reachable only across that one module
 * boundary, and only as a service that returns plain holdings. No client,
 * key, or credential is exported with it.
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
  // valuation) for the authenticated live socket, and both
  // PortfoliosValuationService.valueHoldingsWithPrices and
  // InternalHoldingsService for its timer-free recalculation cycle.
  exports: [PortfoliosValuationService, InternalHoldingsService],
})
export class PortfoliosModule {}
