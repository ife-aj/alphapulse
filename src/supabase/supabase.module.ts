import { Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Provides the configured Supabase client via SupabaseService. ConfigService
 * (global, from AppModule's ConfigModule.forRoot) is injected into the service,
 * so no credentials are hard-coded here.
 *
 * SupabaseService is exported so future modules (Auth, Watchlist) can inject it
 * and reach the underlying client.
 */
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
