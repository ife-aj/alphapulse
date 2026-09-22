import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { toDatabaseHttpException } from './database-errors';
import { toDecimal } from './decimal';
import type { ValuationHolding } from './valuation-computation';

/**
 * Neutral message deliberately identical to the authenticated valuation path's
 * 404 (`PortfoliosValuationService`). A portfolio that does not exist and one
 * that belongs to somebody else must stay indistinguishable to every caller of
 * this reader, exactly as they are on the RLS-scoped path.
 */
const PORTFOLIO_NOT_FOUND = 'Portfolio not found.';

/** The narrowed holding row this reader selects (it never fetches ids/timestamps). */
interface InternalHoldingRow {
  symbol: string;
  quantity: number | string;
  average_purchase_price: number | string;
}

/**
 * Trusted, server-only holdings reader for internal realtime valuation work.
 *
 * Why this exists: the realtime refresh pipeline must load a portfolio's
 * holdings without a caller's access token in hand. The registry deliberately
 * retains no credentials, and a user access token expires — so polling cannot
 * borrow one. This service answers that need with a Supabase client built from
 * the service-role key, which the server holds and a user session never touches.
 *
 * Because that client bypasses Row Level Security, ownership is no longer
 * enforced by the database. It is enforced here, explicitly, by the query — so
 * the rules below are load-bearing rather than defence-in-depth:
 *
 *  - Ownership is proven by constraining `portfolios` on **both** the supplied
 *    `portfolioId` and the supplied `userId`. A `portfolioId` alone is never
 *    sufficient, and there is no code path that reads holdings without a proven
 *    owner.
 *  - The holdings read happens only after ownership succeeds. `holdings` carries
 *    no `user_id` of its own — ownership is inherited from the parent portfolio
 *    — so it is reachable strictly through the portfolio check above.
 *  - A missing portfolio and another user's portfolio both surface as the same
 *    neutral 404, because under this client a foreign portfolio is simply
 *    absent. Callers cannot tell the two apart.
 *
 * Credential boundary: the privileged client is a private field, built on first
 * use and reused thereafter. It is never returned, never logged, and never
 * attached to a response, a DTO, or a socket payload; the only public operation
 * returns plain `ValuationHolding[]`. Nothing here reads or stores a user access
 * token, and `RealtimeSubscriptionService` remains credential-free.
 */
@Injectable()
export class InternalHoldingsService {
  /** Lazily created, then reused. Never returned or logged. */
  private client: SupabaseClient | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Load one portfolio's holdings on behalf of a trusted internal caller.
   *
   * The caller supplies both identities and gets back either the portfolio's
   * normalized holdings (an owned-but-empty portfolio yields `[]`) or the same
   * neutral 404 the authenticated path produces. Database failures pass through
   * the shared `toDatabaseHttpException` mapping, so this reader introduces no
   * new error vocabulary and never surfaces a raw PostgREST message.
   */
  async getInternalValuationHoldings(
    userId: string,
    portfolioId: string,
  ): Promise<ValuationHolding[]> {
    const client = this.supabaseClient();

    try {
      // Step 1 — prove ownership. Both constraints go on `portfolios`, the only
      // table that actually carries a `user_id`; this is the sole authorization
      // check on this path, so neither clause may be dropped.
      const { data: portfolio, error: portfolioError } = await client
        .from('portfolios')
        .select('id')
        .eq('id', portfolioId)
        .eq('user_id', userId)
        .maybeSingle();
      if (portfolioError) {
        throw toDatabaseHttpException(portfolioError, 'get-portfolio');
      }
      if (portfolio === null) {
        throw new NotFoundException(PORTFOLIO_NOT_FOUND);
      }

      // Step 2 — only now, with an owner proven, read the holdings.
      const { data, error } = await client
        .from('holdings')
        .select('symbol, quantity, average_purchase_price')
        .eq('portfolio_id', portfolioId)
        .order('symbol');
      if (error) {
        throw toDatabaseHttpException(error, 'list-holdings');
      }

      return ((data ?? []) as InternalHoldingRow[]).map((row) => ({
        symbol: row.symbol,
        quantity: toDecimal(row.quantity),
        averagePurchasePrice: toDecimal(row.average_purchase_price),
      }));
    } catch (error) {
      // Already-classified failures (the neutral 404 included) pass through
      // untouched; anything else is mapped rather than leaked.
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-holdings');
    }
  }

  /**
   * The privileged client, built on first use and kept for the process.
   *
   * Both values are read through `getOrThrow`, so a module compiled without the
   * startup validator still fails loudly instead of talking to Supabase with an
   * empty credential. Construction performs no network call; the first query
   * does.
   */
  private supabaseClient(): SupabaseClient {
    if (this.client === null) {
      this.client = createClient(
        this.config.getOrThrow<string>('SUPABASE_URL'),
        this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
    }
    return this.client;
  }
}
