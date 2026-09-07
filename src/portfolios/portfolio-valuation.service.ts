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
import {
  moneyString,
  percentString,
  toCanonicalDecimalString,
  toDecimal,
} from './decimal';
import {
  HoldingValuationDto,
  PortfolioValuationDto,
} from './dto/valuation-response.dto';

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
 * Loads one portfolio and its holdings under RLS, fetches a live quote for every
 * held symbol with bounded concurrency (never `Promise.all` over an unbounded
 * list), and computes exact fixed-point values with decimal.js. All financial
 * decimals in the response are JSON strings; rounding happens only when those
 * strings are built — and only for calculated money/percentage figures.
 * `currentPrice` is the exact provider price echoed back canonically, never
 * rounded, so it always agrees with the `currentValue` that was calculated
 * from it.
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

  async getValuation(
    userId: string,
    accessToken: string,
    portfolioId: string,
  ): Promise<PortfolioValuationDto> {
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

      const rows = ((data ?? []) as ValuationHoldingRow[]).map((row) => ({
        symbol: row.symbol,
        quantity: toDecimal(row.quantity),
        averagePurchasePrice: toDecimal(row.average_purchase_price),
        quantityText: toCanonicalDecimalString(row.quantity),
        averagePurchasePriceText: toCanonicalDecimalString(
          row.average_purchase_price,
        ),
      }));

      if (rows.length === 0) {
        return this.emptyValuation(portfolioId);
      }

      // Bounded-concurrency quote fetch. Order is preserved, so prices line up
      // with `rows` by index.
      const prices = await mapWithConcurrency(
        rows.map((row) => row.symbol),
        VALUATION_QUOTE_CONCURRENCY,
        (symbol) => this.fetchCurrentPrice(symbol),
      );

      const holdings: HoldingValuationDto[] = [];
      let totalInvestedExact = new Decimal(0);
      let totalCurrentExact = new Decimal(0);

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const investedExact = row.quantity.mul(row.averagePurchasePrice);
        const currentValueExact = row.quantity.mul(prices[i]);
        const profitLossExact = currentValueExact.sub(investedExact);

        totalInvestedExact = totalInvestedExact.plus(investedExact);
        totalCurrentExact = totalCurrentExact.plus(currentValueExact);

        holdings.push({
          symbol: row.symbol,
          quantity: row.quantityText,
          averagePurchasePrice: row.averagePurchasePriceText,
          // The exact provider price, serialized canonically (never rounded):
          // multiplying this displayed value by the quantity reproduces the
          // currentValue exactly, which would break if the price were rounded
          // to cents first (e.g. 12.5 × 182.7465 = "2284.33", not "2284.38").
          currentPrice: prices[i].toString(),
          investedValue: moneyString(investedExact),
          currentValue: moneyString(currentValueExact),
          profitLoss: moneyString(profitLossExact),
          returnPercentage: percentString(profitLossExact, investedExact),
        });
      }

      const totalProfitLossExact = totalCurrentExact.sub(totalInvestedExact);

      return {
        portfolioId,
        // Totals are the exact sums of the exact per-holding values, rounded
        // once here — never the sum of the rounded per-holding strings.
        totalInvestedValue: moneyString(totalInvestedExact),
        totalCurrentValue: moneyString(totalCurrentExact),
        totalProfitLoss: moneyString(totalProfitLossExact),
        totalReturnPercentage: percentString(
          totalProfitLossExact,
          totalInvestedExact,
        ),
        holdings,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw toDatabaseHttpException(error, 'list-holdings');
    }
  }

  private emptyValuation(portfolioId: string): PortfolioValuationDto {
    return {
      portfolioId,
      totalInvestedValue: moneyString(new Decimal(0)),
      totalCurrentValue: moneyString(new Decimal(0)),
      totalProfitLoss: moneyString(new Decimal(0)),
      totalReturnPercentage: moneyString(new Decimal(0)),
      holdings: [],
    };
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
