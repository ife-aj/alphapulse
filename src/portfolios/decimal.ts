import Decimal from 'decimal.js';

/**
 * Exact-decimal helpers for portfolio money math.
 *
 * The portfolios schema stores quantity and average purchase price as exact
 * `numeric(18,6)`. JS numbers cannot represent every fixed-point decimal, so
 * every value that touches a database numeric cell — and every intermediate in
 * a valuation — goes through decimal.js fixed-point arithmetic and is only
 * turned into a string (never a float) at the boundary. See decimal.js for the
 * exact rounding mode; money/percentages are rounded once, at serialization.
 */

/** Decimal places allowed by `numeric(18,6)`. */
export const DECIMAL_SCALE = 6;

/** Integer digits allowed by `numeric(18,6)` (12 integer + 6 fractional). */
export const DECIMAL_INTEGER_DIGITS = 12;

/** Exclusive upper bound on the magnitude: 10^12 = 1,000,000,000,000. */
export const MAX_DECIMAL_ABS = new Decimal(10).pow(DECIMAL_INTEGER_DIGITS);

/** Round monetary values (and prices) to cents at serialization. */
export const MONEY_DECIMAL_PLACES = 2;

/** Round percentages to two decimal places at serialization. */
export const PERCENT_DECIMAL_PLACES = 2;

/** Construct the exact Decimal for a numeric cell or a validated request value. */
export function toDecimal(value: number | string): Decimal {
  return new Decimal(value);
}

/**
 * Canonical decimal string for a numeric cell or request value: exact, with no
 * trailing zeros (`12.500000` → `"12.5"`). This is the form sent to PostgREST
 * and echoed back for stored fields, so `numeric(18,6)` values never pass
 * through a JS float on the way to or from the database.
 */
export function toCanonicalDecimalString(value: number | string): string {
  return toDecimal(value).toString();
}

/**
 * Format a Decimal as money (two decimal places) for a JSON response. This is
 * the single point where a monetary figure is rounded — computations stay exact
 * up to this string.
 */
export function moneyString(value: Decimal): string {
  return value
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP)
    .toFixed(MONEY_DECIMAL_PLACES);
}

/**
 * Format a profit/loss over an invested base as a percentage string
 * (`part / whole * 100`, two decimal places). A zero base yields `"0.00"` (the
 * empty-portfolio case); with any holding present the invested base is always
 * positive (the schema CHECKs quantity and average price `> 0`).
 */
export function percentString(profitLoss: Decimal, invested: Decimal): string {
  if (invested.isZero()) {
    return new Decimal(0).toFixed(PERCENT_DECIMAL_PLACES);
  }
  return profitLoss
    .div(invested)
    .mul(100)
    .toDecimalPlaces(PERCENT_DECIMAL_PLACES, Decimal.ROUND_HALF_UP)
    .toFixed(PERCENT_DECIMAL_PLACES);
}
