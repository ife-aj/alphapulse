import { RsiStatus } from '../indicators/indicators.types';
import type {
  MacdSummary,
  MovingAverages,
  RsiSummary,
  TechnicalAnalysis,
} from '../indicators/indicators.types';
import { SignalType } from './signal.types';
import type { SignalResult } from './signal.types';

/**
 * Points each indicator contributes when it fires bullish (+) or bearish (-).
 * Four indicators × 25 gives a total score in the range -100..+100.
 */
const INDICATOR_WEIGHT = 25;

/** A single indicator's directional vote: -1 bearish, 0 neutral, +1 bullish. */
type Vote = -1 | 0 | 1;

/** One indicator's contribution: its vote plus a human-readable explanation. */
interface IndicatorSignal {
  vote: Vote;
  reason: string;
}

/**
 * Evaluate a technical-analysis snapshot into an explainable trading signal.
 *
 * Pure and deterministic: the same {@link TechnicalAnalysis} always yields the
 * same result, with no I/O and no dependency on candles or Twelve Data. All
 * indicator math has already happened upstream in IndicatorsService — here we
 * only score the existing readings.
 */
export function evaluateSignal(analysis: TechnicalAnalysis): SignalResult {
  const signals: IndicatorSignal[] = [
    scoreRsi(analysis.rsi),
    scoreSma(analysis.movingAverages),
    scoreEma(analysis.movingAverages),
    scoreMacd(analysis.macd),
  ];

  const score = signals.reduce((sum, s) => sum + s.vote * INDICATOR_WEIGHT, 0);

  return {
    symbol: analysis.symbol,
    signal: classifySignal(score),
    score,
    confidence: computeConfidence(signals, score),
    reasons: signals.map((s) => s.reason),
  };
}

/**
 * Map a score in -100..+100 to a signal band.
 *
 *   +50..+100 -> BUY         +20..+49  -> WEAK_BUY
 *   -19..+19  -> HOLD
 *   -49..-20  -> WEAK_SELL   -100..-50 -> SELL
 */
export function classifySignal(score: number): SignalType {
  if (score >= 50) return SignalType.Buy;
  if (score >= 20) return SignalType.WeakBuy;
  if (score >= -19) return SignalType.Hold;
  if (score >= -49) return SignalType.WeakSell;
  return SignalType.Sell;
}

/**
 * Confidence (0..100): the share of the four indicators that agree with the
 * signal's direction. This is NOT a probability of price movement — it purely
 * measures how unanimous the indicators are.
 *
 *   bullish score -> fraction of indicators voting bullish
 *   bearish score -> fraction voting bearish
 *   flat score (HOLD) -> fraction voting neutral, so a quiet "everyone agrees
 *                        there is no signal" HOLD scores high while a 2-vs-2
 *                        conflict (which also nets to zero) scores low.
 */
function computeConfidence(signals: IndicatorSignal[], score: number): number {
  const direction: Vote = score > 0 ? 1 : score < 0 ? -1 : 0;
  const agreeing = signals.filter((s) => s.vote === direction).length;
  return Math.round((agreeing / signals.length) * 100);
}

/** RSI: oversold is bullish, overbought is bearish. Reuses the upstream status. */
function scoreRsi(rsi: RsiSummary): IndicatorSignal {
  switch (rsi.status) {
    case RsiStatus.Oversold:
      return { vote: 1, reason: 'RSI is oversold' };
    case RsiStatus.Overbought:
      return { vote: -1, reason: 'RSI is overbought' };
    default:
      return { vote: 0, reason: 'RSI is neutral' };
  }
}

/** SMA trend: the faster 20-period average above the slower 50 is bullish. */
function scoreSma(ma: MovingAverages): IndicatorSignal {
  if (ma.sma20 > ma.sma50) return { vote: 1, reason: 'SMA20 is above SMA50' };
  if (ma.sma20 < ma.sma50) return { vote: -1, reason: 'SMA20 is below SMA50' };
  return { vote: 0, reason: 'SMA20 equals SMA50' };
}

/** EMA trend: same idea as the SMA trend, on the exponential averages. */
function scoreEma(ma: MovingAverages): IndicatorSignal {
  if (ma.ema20 > ma.ema50) return { vote: 1, reason: 'EMA20 is above EMA50' };
  if (ma.ema20 < ma.ema50) return { vote: -1, reason: 'EMA20 is below EMA50' };
  return { vote: 0, reason: 'EMA20 equals EMA50' };
}

/** MACD: a positive histogram is bullish momentum, negative is bearish. */
function scoreMacd(macd: MacdSummary): IndicatorSignal {
  if (macd.histogram > 0) {
    return { vote: 1, reason: 'MACD histogram is positive' };
  }
  if (macd.histogram < 0) {
    return { vote: -1, reason: 'MACD histogram is negative' };
  }
  return { vote: 0, reason: 'MACD histogram is flat' };
}
