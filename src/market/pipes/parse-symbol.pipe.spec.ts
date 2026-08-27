import { BadRequestException } from '@nestjs/common';
import { ParseSymbolPipe } from './parse-symbol.pipe';

describe('ParseSymbolPipe', () => {
  const pipe = new ParseSymbolPipe();

  describe('valid symbols', () => {
    it.each([
      ['AAPL', 'AAPL'],
      ['aapl', 'AAPL'], // lower-cased input is normalized
      ['  msft  ', 'MSFT'], // surrounding whitespace is trimmed
      ['F', 'F'], // single-letter tickers are real (Ford)
      ['T', 'T'], // (AT&T)
      ['GOOGL', 'GOOGL'], // 5-letter base
      ['BRK.B', 'BRK.B'], // dotted class share
      ['brk.a', 'BRK.A'],
    ])('accepts %p and normalizes to %p', (input, expected) => {
      expect(pipe.transform(input)).toBe(expected);
    });
  });

  describe('invalid symbols', () => {
    it.each([
      '', // empty
      '   ', // whitespace only
      'BRK-B', // hyphen (Yahoo convention, not ours)
      'BRK/B', // slash (reserved for forex/crypto pairs)
      'TOOLONG', // base longer than 5 letters
      'AAP1', // digits are not allowed
      'A@PL', // punctuation
      'BRK.', // trailing dot, no suffix
      '.B', // missing base
      'BRK.BBB', // suffix longer than 2 letters
    ])('rejects %p with a BadRequestException', (input) => {
      expect(() => pipe.transform(input)).toThrow(BadRequestException);
    });

    it('rejects non-string values', () => {
      expect(() => pipe.transform(undefined)).toThrow(BadRequestException);
      expect(() => pipe.transform(123)).toThrow(BadRequestException);
    });
  });
});
