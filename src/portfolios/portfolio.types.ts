/**
 * Raw PostgREST row shapes for the portfolios schema (snake_case wire format).
 * The services map these onto the camelCase DTOs before they reach a response.
 */
export interface PortfolioRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/**
 * PostgREST serializes `numeric(18,6)` columns as JSON numbers by default, so a
 * holding's `quantity` / `average_purchase_price` arrive as JS numbers. We type
 * them `number | string` and canonicalize every cell to an exact decimal string
 * (`toCanonicalDecimalString`) on the way out, so the wire never makes money
 * math depend on binary-float rounding.
 */
export interface HoldingRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  quantity: number | string;
  average_purchase_price: number | string;
  created_at: string;
  updated_at: string;
}
