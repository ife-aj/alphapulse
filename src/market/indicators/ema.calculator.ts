/**
 * Exponential Moving Average (EMA).
 *
 * Uses the standard calculation: seed with the simple average of the first
 * `period` values, then roll forward with the smoothing multiplier
 * `k = 2 / (period + 1)`:
 *
 *   ema[t] = value[t] * k + ema[t-1] * (1 - k)
 *
 * `calculateEmaSeries` returns one EMA reading per value from index
 * `period - 1` onward (oldest first), so the result has length
 * `values.length - period + 1`. This full series is what MACD consumes.
 * It returns an empty array when there aren't enough values to seed.
 *
 * @param values Series in chronological order (oldest first), e.g. closing prices.
 * @param period Look-back window.
 */
export function calculateEmaSeries(values: number[], period: number): number[] {
  if (!Array.isArray(values) || period < 1 || values.length < period) {
    return [];
  }

  const k = 2 / (period + 1);
  const series: number[] = [];

  // Seed: simple average of the first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  series.push(ema);

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    series.push(ema);
  }

  return series;
}

/**
 * Latest EMA value for a series, or `null` when there aren't enough values to
 * seed a `period`-length average.
 */
export function calculateEma(values: number[], period: number): number | null {
  const series = calculateEmaSeries(values, period);
  return series.length > 0 ? series[series.length - 1] : null;
}
