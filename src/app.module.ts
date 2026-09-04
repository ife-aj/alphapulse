import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { MarketModule } from './market/market.module';
import { SupabaseModule } from './supabase/supabase.module';
import { WatchlistsModule } from './watchlists/watchlists.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    // Loads .env into process.env and exposes ConfigService app-wide. The
    // validate() hook fails the bootstrap on missing/invalid configuration.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    HealthModule,
    MarketModule,
    // Foundation for Auth/Watchlist: exports a configured Supabase client.
    SupabaseModule,
    // Supabase-backed register/login + guarded /auth/me.
    AuthModule,
    // Authenticated, RLS-scoped watchlist CRUD.
    WatchlistsModule,
  ],
})
export class AppModule {}
