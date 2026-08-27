import { calculateMacd } from './macd.calculator';

describe('calculateMacd', () => {
  it('returns null when there is not enough history to seed the signal line', () => {
    // Standard 12/26/9 needs slowPeriod + signalPeriod - 1 = 34 closes.
    const closes = Array.from({ length: 33 }, (_, i) => i + 1);
    expect(calculateMacd(closes)).toBeNull();
  });

  it('produces a result once there is exactly enough history', () => {
    const closes = Array.from({ length: 34 }, (_, i) => i + 1);
    expect(calculateMacd(closes)).not.toBeNull();
  });

  it('computes a known value for a hand-verified small configuration', () => {
    // closes [1..6] with fast=2, slow=3, signal=2:
    //   fast EMA  = [1.5, 2.5, 3.5, 4.5, 5.5]
    //   slow EMA  = [2, 3, 4, 5]  (aligned to the last 4 fast readings)
    //   MACD line = [0.5, 0.5, 0.5, 0.5]  -> signal 0.5 -> histogram 0
    const result = calculateMacd([1, 2, 3, 4, 5, 6], 2, 3, 2);
    expect(result).not.toBeNull();
    expect(result!.macd).toBeCloseTo(0.5, 10);
    expect(result!.signal).toBeCloseTo(0.5, 10);
    expect(result!.histogram).toBeCloseTo(0, 10);
  });

  it('is flat (all zero) for a constant series', () => {
    const result = calculateMacd(Array.from({ length: 40 }, () => 100));
    expect(result).not.toBeNull();
    expect(result!.macd).toBeCloseTo(0, 10);
    expect(result!.signal).toBeCloseTo(0, 10);
    expect(result!.histogram).toBeCloseTo(0, 10);
  });

  it('has a positive MACD line in a sustained uptrend', () => {
    const result = calculateMacd(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(result!.macd).toBeGreaterThan(0);
  });

  it('has a negative MACD line in a sustained downtrend', () => {
    const result = calculateMacd(Array.from({ length: 40 }, (_, i) => 40 - i));
    expect(result!.macd).toBeLessThan(0);
  });

  it('keeps histogram consistent as macd - signal', () => {
    const result = calculateMacd(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(result!.histogram).toBeCloseTo(result!.macd - result!.signal, 10);
  });
});
