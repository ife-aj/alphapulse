import { calculateRsi } from './rsi.calculator';

describe('calculateRsi', () => {
  it('returns null when there are fewer than period + 1 closes', () => {
    expect(calculateRsi([1, 2, 3], 14)).toBeNull();
    // Exactly `period` closes is still one short of the seed requirement.
    expect(
      calculateRsi(
        Array.from({ length: 14 }, (_, i) => i),
        14,
      ),
    ).toBeNull();
  });

  it('returns 100 when every change is a gain', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calculateRsi(closes, 14)).toBe(100);
  });

  it('returns 0 when every change is a loss', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(calculateRsi(closes, 14)).toBe(0);
  });

  it('returns 50 for a perfectly flat series', () => {
    const closes = Array.from({ length: 20 }, () => 100);
    expect(calculateRsi(closes, 14)).toBe(50);
  });

  it('computes a known value for a mixed series (+2 / -1 alternating)', () => {
    // 14 changes: 7 gains of +2 and 7 losses of -1.
    // avgGain = 1, avgLoss = 0.5 -> RS = 2 -> RSI = 100 - 100/3 = 66.67
    const closes = [
      100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107,
    ];
    expect(calculateRsi(closes, 14)).toBeCloseTo(66.67, 2);
  });
});
