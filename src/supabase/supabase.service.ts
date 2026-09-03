import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Owns the single configured Supabase client for the process.
 *
 * The client is built from SUPABASE_URL + SUPABASE_ANON_KEY read through
 * ConfigService — never hard-coded. validateEnv guarantees both exist before
 * the app boots; getOrThrow here keeps a module registered without that guard
 * (e.g. in an isolated test) from silently building a client with empty
 * credentials.
 *
 * The anon key is Supabase's publishable key: it is safe to hold server-side.
 * Every request it issues stays sandboxed by Row Level Security and the auth
 * token a caller attaches, so there is no privileged credential to protect.
 *
 * This runs server-side, so client-side session persistence is disabled — there
 * is no browser localStorage to use, and future Auth/Watchlist code will pass
 * the user's JWT explicitly rather than relying on a stored session.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);

  /** The configured client (anon-key, RLS-scoped). */
  readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');

    this.client = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Deliberately logs nothing about the URL or key — just that it is ready.
    this.logger.log('Supabase client initialised');
  }
}
