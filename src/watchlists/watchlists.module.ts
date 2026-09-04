import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { WatchlistsController } from './watchlists.controller';
import { WatchlistsService } from './watchlists.service';

/**
 * Authenticated watchlist endpoints backed by Supabase Postgres + RLS.
 *
 * Imports SupabaseModule (for SupabaseService, injected by WatchlistsService)
 * and AuthModule (for SupabaseAuthGuard, which protects every route).
 */
@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [WatchlistsController],
  providers: [WatchlistsService],
})
export class WatchlistsModule {}
