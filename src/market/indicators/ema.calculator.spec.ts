import { calculateEma, calculateEmaSeries } from './ema.calculator';

describe('calculateEmaSeries', () => {
  it('returns an empty series when there are fewer than `period` values', () => {
    expect(calculateEmaSeries([1, 2], 3)).toEqual([]);
    expect(calculateEmaSeries([], 1)).toEqual([]);
  });

  it('returns one reading per value from index `period - 1` onward', () => {
    // length = values.length - period + 1
    expect(calculateEmaSeries([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });

  it('seeds with the SMA of the first `period` values, then smooths', () => {
    // seed = (1+2+3)/3 = 2; k = 0.5
    //   -> 4*0.5 + 2*0.5 = 3
    //   -> 5*0.5 + 3*0.5 = 4
    expect(calculateEmaSeries([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
  });
});

describe('calculateEma', () => {
  it('returns null when there are fewer than `period` values', () => {
    expect(calculateEma([1, 2], 3)).toBeNull();
  });

  it('returns the latest value of the EMA series', () => {
    expect(calculateEma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(calculateEma([2, 4, 6, 8, 10], 3)).toBe(8);
  });

  it('holds steady on a flat series', () => {
    expect(calculateEma([7, 7, 7, 7], 2)).toBe(7);
  });

  it('tracks the latest value exactly when period is 1', () => {
    // k = 1, so each EMA equals the current value.
    expect(calculateEma([5, 9, 3], 1)).toBe(3);
  });
});
