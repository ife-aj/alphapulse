import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { PortfoliosValuationService } from './portfolio-valuation.service';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';

/**
 * Authenticated portfolio CRUD, holdings, and live valuation.
 *
 * Needs MarketModule only for its exported MarketService (used by the read-only
 * valuation service to fetch live quotes).
 */
@Module({
  imports: [SupabaseModule, AuthModule, MarketModule],
  controllers: [PortfoliosController],
  providers: [PortfoliosService, PortfoliosValuationService],
})
export class PortfoliosModule {}
