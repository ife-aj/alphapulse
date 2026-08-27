/**
 * Standard Wilder's Relative Strength Index (RSI).
 *
 * Seeds the initial average gain/loss from the first `period` price changes,
 * then applies Wilder's smoothing across the rest, returning the most recent
 * RSI value (0..100).
 *
 * Returns `null` when there aren't enough closes to seed the average — a
 * `period`-length RSI needs at least `period + 1` closing prices.
 *
 * @param closes Closing prices in chronological order (oldest first).
 * @param period Look-back window; defaults to the standard 14.
 */
export function calculateRsi(closes: number[], period = 14): number | null {
  if (!Array.isArray(closes) || period < 1 || closes.length < period + 1) {
    return null;
  }

  // Seed: simple average of the gains/losses over the first `period` changes.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing over the remaining changes.
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  return rsiFromAverages(avgGain, avgLoss);
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50; // perfectly flat -> neutral
  if (avgLoss === 0) return 100; // only gains -> max
  if (avgGain === 0) return 0; // only losses -> min
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
