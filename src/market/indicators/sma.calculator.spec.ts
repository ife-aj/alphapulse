import { calculateSma } from './sma.calculator';

describe('calculateSma', () => {
  it('returns null when there are fewer than `period` values', () => {
    expect(calculateSma([1, 2, 3], 5)).toBeNull();
    expect(calculateSma([], 1)).toBeNull();
  });

  it('returns null for a non-positive period', () => {
    expect(calculateSma([1, 2, 3], 0)).toBeNull();
    expect(calculateSma([1, 2, 3], -1)).toBeNull();
  });

  it('averages exactly `period` values', () => {
    expect(calculateSma([2, 4, 6], 3)).toBe(4);
  });

  it('averages only the most recent `period` values', () => {
    // Last 3 of [1,2,3,4,5,6] -> (4+5+6)/3 = 5.
    expect(calculateSma([1, 2, 3, 4, 5, 6], 3)).toBe(5);
  });

  it('supports configurable periods over the same series', () => {
    const closes = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50
    // Last 20: 31..50 -> mean 40.5. Last 50: 1..50 -> mean 25.5.
    expect(calculateSma(closes, 20)).toBeCloseTo(40.5, 10);
    expect(calculateSma(closes, 50)).toBeCloseTo(25.5, 10);
  });
});
