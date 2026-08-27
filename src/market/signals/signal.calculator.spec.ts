import { RsiStatus } from '../indicators/indicators.types';
import type { TechnicalAnalysis } from '../indicators/indicators.types';
import { classifySignal, evaluateSignal } from './signal.calculator';
import { SignalType } from './signal.types';

type Dir = 'bull' | 'bear' | 'flat';

/**
 * Build a TechnicalAnalysis fixture from per-indicator directions. Every
 * indicator defaults to neutral; each knob nudges one indicator bullish or
 * bearish so a test can dial in an exact score.
 */
function buildAnalysis(
  dirs: { rsi?: Dir; sma?: Dir; ema?: Dir; macd?: Dir; symbol?: string } = {},
): TechnicalAnalysis {
  const {
    rsi = 'flat',
    sma = 'flat',
    ema = 'flat',
    macd = 'flat',
    symbol = 'AAPL',
  } = dirs;

  const rsiSummary = {
    bull: { value: 25, status: RsiStatus.Oversold },
    bear: { value: 80, status: RsiStatus.Overbought },
    flat: { value: 50, status: RsiStatus.Neutral },
  }[rsi];

  // Encode MA direction through the 20-vs-50 relationship (50 fixed at 100).
  const sma20 = sma === 'bull' ? 110 : sma === 'bear' ? 90 : 100;
  const ema20 = ema === 'bull' ? 110 : ema === 'bear' ? 90 : 100;
  const histogram = macd === 'bull' ? 1.5 : macd === 'bear' ? -1.5 : 0;

  return {
    symbol,
    rsi: rsiSummary,
    movingAverages: { sma20, sma50: 100, ema20, ema50: 100 },
    macd: { value: histogram, signal: 0, histogram },
  };
}

describe('evaluateSignal', () => {
  describe('unanimous scenarios', () => {
    it('scores every indicator bullish as a full-confidence BUY', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bull', sma: 'bull', ema: 'bull', macd: 'bull' }),
      );
      expect(result.score).toBe(100);
      expect(result.signal).toBe(SignalType.Buy);
      expect(result.confidence).toBe(100);
    });

    it('scores every indicator bearish as a full-confidence SELL', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bear', sma: 'bear', ema: 'bear', macd: 'bear' }),
      );
      expect(result.score).toBe(-100);
      expect(result.signal).toBe(SignalType.Sell);
      expect(result.confidence).toBe(100);
    });

    it('treats an all-neutral snapshot as a confident HOLD', () => {
      const result = evaluateSignal(buildAnalysis());
      expect(result.score).toBe(0);
      expect(result.signal).toBe(SignalType.Hold);
      // All four indicators "agree" there is no signal.
      expect(result.confidence).toBe(100);
    });
  });

  describe('score arithmetic', () => {
    it('adds 25 for each individual bullish indicator', () => {
      expect(evaluateSignal(buildAnalysis({ rsi: 'bull' })).score).toBe(25);
      expect(evaluateSignal(buildAnalysis({ sma: 'bull' })).score).toBe(25);
      expect(evaluateSignal(buildAnalysis({ ema: 'bull' })).score).toBe(25);
      expect(evaluateSignal(buildAnalysis({ macd: 'bull' })).score).toBe(25);
    });

    it('subtracts 25 for each individual bearish indicator', () => {
      expect(evaluateSignal(buildAnalysis({ rsi: 'bear' })).score).toBe(-25);
      expect(evaluateSignal(buildAnalysis({ sma: 'bear' })).score).toBe(-25);
      expect(evaluateSignal(buildAnalysis({ ema: 'bear' })).score).toBe(-25);
      expect(evaluateSignal(buildAnalysis({ macd: 'bear' })).score).toBe(-25);
    });
  });

  describe('mixed scenarios', () => {
    it('nets opposing votes toward the majority (3 bull, 1 bear -> +50 BUY)', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bull', sma: 'bull', ema: 'bull', macd: 'bear' }),
      );
      expect(result.score).toBe(50);
      expect(result.signal).toBe(SignalType.Buy);
      // 3 of 4 indicators back the bullish direction.
      expect(result.confidence).toBe(75);
    });

    it('classifies a lone bullish indicator as WEAK_BUY', () => {
      const result = evaluateSignal(buildAnalysis({ ema: 'bull' }));
      expect(result.score).toBe(25);
      expect(result.signal).toBe(SignalType.WeakBuy);
      expect(result.confidence).toBe(25);
    });

    it('classifies a lone bearish indicator as WEAK_SELL', () => {
      const result = evaluateSignal(buildAnalysis({ macd: 'bear' }));
      expect(result.score).toBe(-25);
      expect(result.signal).toBe(SignalType.WeakSell);
      expect(result.confidence).toBe(25);
    });

    it('treats a 2-vs-2 conflict as a zero-confidence HOLD', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bull', sma: 'bull', ema: 'bear', macd: 'bear' }),
      );
      expect(result.score).toBe(0);
      expect(result.signal).toBe(SignalType.Hold);
      // No indicator is neutral, so nothing "agrees" with the HOLD.
      expect(result.confidence).toBe(0);
    });

    it('measures confidence against the winning direction only (2 bull, 1 bear, 1 flat)', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bull', sma: 'bull', ema: 'bear' }), // macd flat
      );
      expect(result.score).toBe(25);
      expect(result.signal).toBe(SignalType.WeakBuy);
      // Only 2 of 4 vote bullish, even though the net is positive.
      expect(result.confidence).toBe(50);
    });
  });

  describe('reasons', () => {
    it('emits one explanation per indicator in a fixed order', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'flat', sma: 'bear', ema: 'bull', macd: 'bull' }),
      );
      expect(result.reasons).toEqual([
        'RSI is neutral',
        'SMA20 is below SMA50',
        'EMA20 is above EMA50',
        'MACD histogram is positive',
      ]);
    });

    it('explains overbought and bearish states', () => {
      const result = evaluateSignal(
        buildAnalysis({ rsi: 'bear', sma: 'bull', ema: 'bear', macd: 'bear' }),
      );
      expect(result.reasons).toEqual([
        'RSI is overbought',
        'SMA20 is above SMA50',
        'EMA20 is below EMA50',
        'MACD histogram is negative',
      ]);
    });
  });

  it('carries the symbol through from the analysis', () => {
    const result = evaluateSignal(buildAnalysis({ symbol: 'MSFT' }));
    expect(result.symbol).toBe('MSFT');
  });
});

describe('classifySignal boundaries', () => {
  it('maps the BUY band (+50..+100)', () => {
    expect(classifySignal(100)).toBe(SignalType.Buy);
    expect(classifySignal(50)).toBe(SignalType.Buy);
  });

  it('maps the WEAK_BUY band (+20..+49)', () => {
    expect(classifySignal(49)).toBe(SignalType.WeakBuy);
    expect(classifySignal(25)).toBe(SignalType.WeakBuy);
    expect(classifySignal(20)).toBe(SignalType.WeakBuy);
  });

  it('maps the HOLD band (-19..+19)', () => {
    expect(classifySignal(19)).toBe(SignalType.Hold);
    expect(classifySignal(0)).toBe(SignalType.Hold);
    expect(classifySignal(-19)).toBe(SignalType.Hold);
  });

  it('maps the WEAK_SELL band (-49..-20)', () => {
    expect(classifySignal(-20)).toBe(SignalType.WeakSell);
    expect(classifySignal(-25)).toBe(SignalType.WeakSell);
    expect(classifySignal(-49)).toBe(SignalType.WeakSell);
  });

  it('maps the SELL band (-100..-50)', () => {
    expect(classifySignal(-50)).toBe(SignalType.Sell);
    expect(classifySignal(-100)).toBe(SignalType.Sell);
  });

  it('splits cleanly at every band edge', () => {
    expect(classifySignal(50)).toBe(SignalType.Buy);
    expect(classifySignal(49)).toBe(SignalType.WeakBuy);
    expect(classifySignal(20)).toBe(SignalType.WeakBuy);
    expect(classifySignal(19)).toBe(SignalType.Hold);
    expect(classifySignal(-19)).toBe(SignalType.Hold);
    expect(classifySignal(-20)).toBe(SignalType.WeakSell);
    expect(classifySignal(-49)).toBe(SignalType.WeakSell);
    expect(classifySignal(-50)).toBe(SignalType.Sell);
  });
});
