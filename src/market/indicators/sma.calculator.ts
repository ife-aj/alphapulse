/**
 * Simple Moving Average (SMA).
 *
 * Returns the arithmetic mean of the most recent `period` values, or `null`
 * when there aren't enough values to fill the window — a `period`-length SMA
 * needs at least `period` values.
 *
 * @param values Series in chronological order (oldest first), e.g. closing prices.
 * @param period Look-back window (number of values to average).
 */
export function calculateSma(values: number[], period: number): number | null {
  if (!Array.isArray(values) || period < 1 || values.length < period) {
    return null;
  }

  // Average only the last `period` values (the most recent window).
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}
