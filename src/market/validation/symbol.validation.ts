/**
 * Single source of truth for what a valid stock symbol looks like in AlphaPulse.
 * Shared by ParseSymbolPipe (the `:symbol` path param) and GetQuotesQueryDto
 * (the `?symbols=` list) so both entry points enforce exactly the same rule.
 *
 * Rule (verified against our providers, Finnhub + Twelve Data):
 *   - 1–5 uppercase letters (e.g. F, T, AAPL, GOOGL)
 *   - an optional dotted class suffix of 1–2 letters (e.g. BRK.B, BRK.A)
 *   - no digits, hyphens, or slashes: those belong to other conventions
 *     (Yahoo writes BRK-B, Bloomberg BRK/B) or are reserved by Twelve Data for
 *     forex/crypto pairs (EUR/USD), which AlphaPulse does not support yet.
 */
export const SYMBOL_REGEX = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

/** Human-readable format hint reused across validation error messages. */
export const SYMBOL_FORMAT_HINT = 'Expected a ticker such as AAPL or BRK.B.';

/** Maximum number of symbols accepted in a single `?symbols=` request. */
export const MAX_SYMBOLS = 20;

/** Canonical form we send upstream: trimmed and upper-cased. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True when an already-normalized `symbol` matches the supported format. */
export function isValidSymbol(symbol: string): boolean {
  return SYMBOL_REGEX.test(symbol);
}

/**
 * Normalize a raw `?symbols=` query value into a clean ticker list.
 *
 * Returns `undefined` when the parameter is absent, so class-validator's
 * `@IsOptional()` treats it as "use the default symbols". An explicitly empty
 * value (`?symbols=`) normalizes to an empty array, which `@ArrayNotEmpty()`
 * then rejects with a 400 — the caller asked for a list but supplied nothing.
 *
 * Accepts both the usual `?symbols=A,B` string and the `?symbols=A&symbols=B`
 * array shape Express can produce.
 */
export function parseSymbolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parts = Array.isArray(value)
    ? value.map((part) => String(part))
    : String(value).split(',');

  return parts.map((part) => normalizeSymbol(part)).filter((s) => s.length > 0);
}
