import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Owns Supabase client construction for the process.
 *
 * The clients are built from SUPABASE_URL + SUPABASE_ANON_KEY read through
 * ConfigService — never hard-coded. validateEnv guarantees both exist before
 * the app boots; getOrThrow here keeps a module registered without that guard
 * (e.g. in an isolated test) from silently building a client with empty
 * credentials.
 *
 * The anon key is Supabase's publishable key: it is safe to hold server-side.
 * Every request it issues stays sandboxed by Row Level Security and the auth
 * token a caller attaches, so there is no privileged credential to protect.
 *
 * Concurrency rule: nothing here may retain a per-user session on a shared
 * instance. The singleton `client` is fine for unauthenticated reads, but any
 * operation that signs a user in/up or verifies a token must use a freshly
 * created client (`createAuthClient()`, `createUserClient()`) so a session
 * held in one request's client can never be seen by another concurrent request.
 *
 * Server-side, session persistence is always disabled — there is no browser
 * localStorage to use, and callers pass the user's JWT explicitly rather than
 * relying on a stored session.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);

  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  /** The configured client (anon-key, RLS-scoped) for unauthenticated reads. */
  readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    this.supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    this.supabaseAnonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');

    this.client = createClient(this.supabaseUrl, this.supabaseAnonKey, {
      auth: this.serverAuthOptions(),
    });

    // Deliberately logs nothing about the URL or key — just that it is ready.
    this.logger.log('Supabase client initialised');
  }

  /**
   * A fresh, isolated, non-persistent client for a single auth operation.
   *
   * A brand-new instance is returned on every call. Supabase retains the signed
   * in/up session in memory on the client that performed the call, so sharing
   * one client across requests could leak one user's session into another
   * request. Creating a client per operation makes cross-request leakage
   * impossible by construction.
   */
  createAuthClient(): SupabaseClient {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      auth: this.serverAuthOptions(),
    });
  }

  /**
   * A fresh client that forwards the request's bearer token on every call, for
   * authenticated database operations (scoped by Row Level Security to that
   * user). The shared singleton client is never mutated with per-user headers,
   * so its state stays clean for unauthenticated reads.
   */
  createUserClient(accessToken: string): SupabaseClient {
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      throw new Error('createUserClient requires a non-empty access token');
    }
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      auth: this.serverAuthOptions(),
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    });
  }

  private serverAuthOptions() {
    return { autoRefreshToken: false, persistSession: false };
  }
}
