import {
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { MarketService } from '../market/market.service';
import { SupabaseService } from '../supabase/supabase.service';
import { mapWithConcurrency, VALUATION_QUOTE_CONCURRENCY } from './concurrency';
import { toDatabaseHttpException } from './database-errors';
import { toDecimal } from './decimal';
import { PortfolioValuationDto } from './dto/valuation-response.dto';
import {
  computePortfolioValuation,
  ValuationHolding,
} from './valuation-computation';

const PORTFOLIO_NOT_FOUND = 'Portfolio not found.';
const NO_MARKET_DATA =
  'No market data for symbol "%s". Unable to value this holding.';
const INVALID_MARKET_DATA =
  'No valid market data for symbol "%s". Unable to value this holding.';

/** The narrowed holding row the valuation reads (it never fetches ids/timestamps). */
interface ValuationHoldingRow {
  symbol: string;
  quantity: number | string;
  average_purchase_price: number | string;
}

/**
 * Live portfolio valuation — read-only.
 *
 * The flow is split into three independently reusable phases:
 *
 *  1. `getValuationHoldings` — authorize the request and load one portfolio's
 *     holdings under RLS as normalized domain values.
 *  2. `valueHoldings` — fetch and validate a live quote for every held symbol
 *     with bounded concurrency (never `Promise.all` over an unbounded list).
 *  3. `computePortfolioValuation` (pure, in `./valuation-computation`) — exact
 *     fixed-point arithmetic over Decimals; rounding happens only when response
 *     strings are built, and only for calculated money/percentage figures.
 *
 * `getValuation` orchestrates the first two and is the single entry point the
 * REST controller and the realtime gateway both call, unchanged. The third
 * phase is the seam a future realtime poller reuses when it already has prices.
 *
 * All financial decimals in the response are JSON strings; `currentPrice` is the
 * exact provider price echoed back canonically, never rounded, so it always
 * agrees with the `currentValue` that was calculated from it.
 *
 * Contracts:
 *  - An empty portfolio returns zero totals and makes NO market calls.
 *  - Quote failures are all-or-nothing: if any holding cannot be valued the whole
 *    request fails. A symbol with no market data (the provider's 404 "unknown
 *    symbol") is an unprocessable *valuation*, not a missing resource, so it is
 *    translated to 422; provider transport failures (429/5xx/timeout) pass
 *    through unchanged.
 *  - The endpoint never writes: this service only ever selects from Supabase.
 */
@Injectable()
export class PortfoliosValuationService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly marketService: MarketService,
  ) {}

  /**
   * Authorize + load the holdings, then price and value them. Externally
   * unchanged: the REST controller and the realtime gateway call this and
   * receive the same DTO and errors as before.
   */
  async getValuation(
    userId: string,
    accessToken: string,
    portfolioId: string,
  ): Promise<PortfolioValuationDto> {
    const holdings = await this.getValuationHoldings(
      userId,
      accessToken,
      portfolioId,
    );
    return this.valueHoldings(portfolioId, holdings);
  }

  /**
   * Authorize the request against the verified user and load that portfolio's
   * holdings as normalized domain values.
   *
   * Ownership is scoped to `userId` (derived from the verified token, never from
   * any client-controlled data) and a missing portfolio and another user's
   * portfolio collapse to the same neutral 404. Holdings use the same narrow
   * select as the REST valuation (never ids/timestamps) and stay ordered by
   * symbol. Numeric cells are normalized into exact Decimals here — raw
   * Supabase/PostgREST rows never leave the portfolios module.
   */
  async getValuationHoldings(
    userId: string,
    accessToken: string,
    portfolioId: string,
  ): Promise<ValuationHolding[]> {
    const client = this.supabase.createUserClient(accessToken);
    try {
      const { data: portfolio, error: portfolioError } = await client
        .from('portfolios')
        .select('id')
        .eq('id', portfolioId)
        .eq('user_id', userId)
        .maybeSingle();
      if (portfolioError)
        throw toDatabaseHttpException(portfolioError, 'get-portfolio');
      if (portfolio === null) throw new NotFoundException(PORTFOLIO_NOT_FOUND);

      const { data, error } = await client
        .from('holdings')
        .select('symbol, quantity, average_purchase_price')
        .eq('portfolio_id', portfolioId)
        .order('symbol');
      if (error) throw toDatabaseHttpException(error, 'list-holdings');

      return ((data ?? []) as ValuationHoldingRow[]).map((row) => ({
        symbol: row.symbol,
        quantity: toDecimal(row.quantity),
        averagePurchasePrice: toDecimal(row.average_purchase_price),
      }));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-holdings');
    }
  }

  /**
   * Price already-loaded holdings and compute their valuation. This is the
   * shared phase a future realtime poller can call with prices it already has.
   *
   * An empty holding set returns the exact zero valuation and makes NO market
   * calls. Otherwise every held symbol is fetched through the bounded-concurrency
   * worker pool — one provider call per holding in input order — and the whole
   * request is all-or-nothing: if any holding cannot be valued the computation
   * is discarded and the error thrown. Provider behaviour is unchanged:
   * unknown-symbol 404 → 422, non-positive/non-finite price → 422, transport and
   * rate-limit failures pass through. Validated prices are paired back onto
   * their holdings by position and handed to the pure `computePortfolioValuation`.
   */
  async valueHoldings(
    portfolioId: string,
    holdings: readonly ValuationHolding[],
  ): Promise<PortfolioValuationDto> {
    try {
      if (holdings.length === 0) {
        return computePortfolioValuation(portfolioId, []);
      }

      // Bounded-concurrency quote fetch. Order is preserved, so prices line up
      // with `holdings` by index.
      const prices = await mapWithConcurrency(
        holdings.map((holding) => holding.symbol),
        VALUATION_QUOTE_CONCURRENCY,
        (symbol) => this.fetchCurrentPrice(symbol),
      );

      return computePortfolioValuation(
        portfolioId,
        holdings.map((holding, index) => ({
          ...holding,
          currentPrice: prices[index],
        })),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-holdings');
    }
  }

  /**
   * Fetch the exact current price for one symbol, translating the provider's
   * "unknown symbol" 404 into a 422 valuation error. Anything else (provider
   * rate limits, 5xx, timeouts) propagates unchanged.
   */
  private async fetchCurrentPrice(symbol: string): Promise<Decimal> {
    try {
      const quotes = await this.marketService.getQuotes([symbol]);
      const price = quotes[0]?.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new UnprocessableEntityException(
          INVALID_MARKET_DATA.replace('%s', symbol),
        );
      }
      // The exact decimal from the provider's `c` field is retained here and
      // used throughout the calculation; no premature rounding.
      return new Decimal(price);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnprocessableEntityException(
          NO_MARKET_DATA.replace('%s', symbol),
        );
      }
      throw error;
    }
  }
}
