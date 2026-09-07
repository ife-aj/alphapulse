import Decimal from 'decimal.js';
import {
  DECIMAL_INTEGER_DIGITS,
  DECIMAL_SCALE,
  MAX_DECIMAL_ABS,
  moneyString,
  percentString,
  toCanonicalDecimalString,
  toDecimal,
} from './decimal';

describe('decimal helpers', () => {
  describe('toDecimal / toCanonicalDecimalString', () => {
    it('constructs exact decimals from numbers and numeric strings', () => {
      expect(toDecimal(0.1).toString()).toBe('0.1');
      expect(toDecimal('12.500000').toString()).toBe('12.5');
      expect(toDecimal('152.3755').toString()).toBe('152.3755');
    });

    it('produces canonical strings without trailing zeros', () => {
      expect(toCanonicalDecimalString('12.500000')).toBe('12.5');
      expect(toCanonicalDecimalString(12.5)).toBe('12.5');
      expect(toCanonicalDecimalString('152.375500')).toBe('152.3755');
      expect(toCanonicalDecimalString(0.1)).toBe('0.1');
      expect(toCanonicalDecimalString('100')).toBe('100');
    });

    it('keeps sub-cent provider prices exact through Decimal', () => {
      // 182.7465 arrives as a JS number that round-trips to the same decimal
      // text it was parsed from, so Decimal(price) is the exact provider value.
      expect(toDecimal(182.7465).toString()).toBe('182.7465');
    });
  });

  describe('moneyString', () => {
    it('rounds half-up to two decimal places', () => {
      expect(moneyString(new Decimal('2284.375'))).toBe('2284.38');
      expect(moneyString(new Decimal('1904.69375'))).toBe('1904.69');
      expect(moneyString(new Decimal('91.375'))).toBe('91.38');
      expect(moneyString(new Decimal('827.465'))).toBe('827.47');
    });

    it('formats negative money away from zero (half-up)', () => {
      expect(moneyString(new Decimal('-12.345'))).toBe('-12.35');
    });

    it('formats zero', () => {
      expect(moneyString(new Decimal(0))).toBe('0.00');
    });

    it('is the only rounding boundary: exact values pass through unchanged', () => {
      expect(moneyString(new Decimal('1100'))).toBe('1100.00');
      expect(moneyString(new Decimal('1.005'))).toBe('1.01');
    });
  });

  describe('percentString', () => {
    it('computes part / whole * 100 rounded to two decimal places', () => {
      expect(percentString(new Decimal('827.465'), new Decimal('1000'))).toBe(
        '82.75',
      );
      expect(percentString(new Decimal('40'), new Decimal('240'))).toBe(
        '16.67',
      );
    });

    it('returns 0.00 for a zero (empty) base', () => {
      expect(percentString(new Decimal('12.50'), new Decimal(0))).toBe('0.00');
    });
  });

  describe('schema-bounds constants', () => {
    it('numeric(18,6) is 12 integer digits and 6 decimal places', () => {
      expect(DECIMAL_INTEGER_DIGITS).toBe(12);
      expect(DECIMAL_SCALE).toBe(6);
      expect(MAX_DECIMAL_ABS.toString()).toBe('1000000000000');
    });
  });
});
