import Decimal from 'decimal.js';
import { moneyString, percentString } from './decimal';
import {
  HoldingValuationDto,
  PortfolioValuationDto,
} from './dto/valuation-response.dto';

/**
 * Pure portfolio-valuation domain inputs.
 *
 * These types sit between the raw Supabase/PostgREST rows (snake_case numeric
 * cells typed `number | string`) and the public response DTOs (every financial
 * decimal a JSON string). A `ValuationHolding` is an authorized holding whose
 * quantity and average purchase price have been normalized into exact Decimals —
 * financial values are never converted back into JS numbers. Pricing a holding
 * adds the validated live market price, producing the input to
 * `computePortfolioValuation`.
 *
 * The realtime module consumes these via `PortfoliosValuationService`; raw
 * database field names and provider `Quote` objects never cross that boundary.
 */
export interface ValuationHolding {
  symbol: string;
  quantity: Decimal;
  averagePurchasePrice: Decimal;
}

/** A normalized holding paired with its validated live market price. */
export interface PricedValuationHolding extends ValuationHolding {
  currentPrice: Decimal;
}

/**
 * Compute a portfolio valuation from already-priced holdings.
 *
 * Pure: performs no database, network, logging, configuration, or mutation.
 * Every financial figure uses exact decimal.js arithmetic; calculated money and
 * percentage values are rounded once, when their strings are built — never
 * before. Stored/source decimals (`quantity`, `averagePurchasePrice`,
 * `currentPrice`) are echoed as exact canonical strings — no trailing zeros, no
 * premature rounding — so `quantity × currentPrice` always reproduces the
 * displayed `currentValue`.
 *
 * Holdings are valued in their exact input positions: there is no symbol-based
 * reordering or deduplication, so duplicate symbols are each calculated where
 * they appear. An empty `holdings` array yields the exact empty valuation (zero
 * totals, no holdings) with no further work required of the caller.
 */
export function computePortfolioValuation(
  portfolioId: string,
  holdings: readonly PricedValuationHolding[],
): PortfolioValuationDto {
  const holdingValuations: HoldingValuationDto[] = [];
  let totalInvestedExact = new Decimal(0);
  let totalCurrentExact = new Decimal(0);

  for (const holding of holdings) {
    const investedExact = holding.quantity.mul(holding.averagePurchasePrice);
    const currentValueExact = holding.quantity.mul(holding.currentPrice);
    const profitLossExact = currentValueExact.sub(investedExact);

    totalInvestedExact = totalInvestedExact.plus(investedExact);
    totalCurrentExact = totalCurrentExact.plus(currentValueExact);

    holdingValuations.push({
      symbol: holding.symbol,
      // Exact canonical echoes — Decimal normalizes at construction, so e.g. a
      // numeric cell of "12.500000" round-trips as "12.5".
      quantity: holding.quantity.toString(),
      averagePurchasePrice: holding.averagePurchasePrice.toString(),
      // The exact provider price the arithmetic used, serialized canonically
      // (never rounded): multiplying this displayed value by the quantity
      // reproduces the currentValue exactly, which would break if the price
      // were rounded to cents first (e.g. 12.5 × 182.7465 = "2284.33", not
      // "2284.38").
      currentPrice: holding.currentPrice.toString(),
      investedValue: moneyString(investedExact),
      currentValue: moneyString(currentValueExact),
      profitLoss: moneyString(profitLossExact),
      returnPercentage: percentString(profitLossExact, investedExact),
    });
  }

  const totalProfitLossExact = totalCurrentExact.sub(totalInvestedExact);

  return {
    portfolioId,
    // Totals are the exact sums of the exact per-holding values, rounded once
    // here — never the sum of the already-rounded per-holding strings.
    totalInvestedValue: moneyString(totalInvestedExact),
    totalCurrentValue: moneyString(totalCurrentExact),
    totalProfitLoss: moneyString(totalProfitLossExact),
    totalReturnPercentage: percentString(
      totalProfitLossExact,
      totalInvestedExact,
    ),
    holdings: holdingValuations,
  };
}
