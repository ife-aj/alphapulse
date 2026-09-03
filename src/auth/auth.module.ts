import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './supabase-auth.guard';

/**
 * Authentication slice backed by Supabase Auth.
 *
 * Imports SupabaseModule so SupabaseService is injectable here. Exports
 * AuthService and SupabaseAuthGuard so future modules (e.g. Watchlist) can
 * validate tokens and re-use the same guard without re-implementing it.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard],
  exports: [AuthService, SupabaseAuthGuard],
})
export class AuthModule {}
