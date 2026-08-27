import { calculateEmaSeries } from './ema.calculator';

/** Standard MACD component values (all derived from closing prices). */
export interface MacdValues {
  macd: number; // MACD line: fast EMA - slow EMA
  signal: number; // EMA of the MACD line
  histogram: number; // macd - signal
}

/**
 * Moving Average Convergence Divergence (MACD).
 *
 * Builds the fast and slow EMA series over `closes`, differences them into the
 * MACD line, then smooths that line into the signal line. Returns the latest
 * MACD/signal/histogram triple, or `null` when there isn't enough history.
 *
 * The two EMA series begin at different offsets (the slow one starts later), so
 * the fast series is trimmed to align with the slow one before differencing.
 *
 * Enough history means `slowPeriod + signalPeriod - 1` closes (34 for the
 * standard 12/26/9 configuration) — the point at which the signal EMA can seed.
 *
 * @param closes      Closing prices in chronological order (oldest first).
 * @param fastPeriod  Fast EMA look-back (default 12).
 * @param slowPeriod  Slow EMA look-back (default 26).
 * @param signalPeriod Signal EMA look-back over the MACD line (default 9).
 */
export function calculateMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdValues | null {
  if (!Array.isArray(closes)) return null;

  const fast = calculateEmaSeries(closes, fastPeriod);
  const slow = calculateEmaSeries(closes, slowPeriod);
  if (fast.length === 0 || slow.length === 0) return null;

  // The slow EMA seeds later, so align the tail of the fast series to it.
  // Both series end at the last close, so trimming the fast series' head by the
  // length difference lines the two up index-for-index.
  const offset = fast.length - slow.length;
  const macdLine: number[] = [];
  for (let j = 0; j < slow.length; j++) {
    macdLine.push(fast[j + offset] - slow[j]);
  }

  const signalSeries = calculateEmaSeries(macdLine, signalPeriod);
  if (signalSeries.length === 0) return null;

  const macd = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { macd, signal, histogram: macd - signal };
}
