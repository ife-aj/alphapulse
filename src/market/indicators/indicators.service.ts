import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { MarketService } from '../market.service';
import { calculateRsi } from './rsi.calculator';
import { calculateSma } from './sma.calculator';
import { calculateEma } from './ema.calculator';
import { calculateMacd } from './macd.calculator';
import {
  MovingAverages,
  RsiResult,
  RsiStatus,
  TechnicalAnalysis,
} from './indicators.types';

/** Standard RSI look-back period. */
const RSI_PERIOD = 14;

/** Moving-average look-backs surfaced by the combined endpoint. */
const SMA_SHORT = 20;
const SMA_LONG = 50;
const EMA_SHORT = 20;
const EMA_LONG = 50;

/** Standard MACD configuration. */
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

@Injectable()
export class IndicatorsService {
  constructor(private readonly marketService: MarketService) {}

  /**
   * Compute the latest RSI for a symbol from its historical closing prices.
   * Reuses the existing candle pipeline (Twelve Data) rather than re-fetching.
   */
  async getRsi(
    symbol: string,
    period: number = RSI_PERIOD,
  ): Promise<RsiResult> {
    const normalized = symbol.trim().toUpperCase();

    // Pull well beyond the `period + 1` minimum so Wilder's smoothing settles
    // to a value consistent with common charting tools.
    const lookback = Math.max(period * 5, 50);
    const candles = await this.marketService.getCandles(normalized, lookback);
    const closes = candles.map((candle) => candle.close);

    const rsi = calculateRsi(closes, period);
    if (rsi === null) {
      throw new UnprocessableEntityException(
        `Not enough price history to compute a ${period}-period RSI for ` +
          `"${normalized}" (need at least ${period + 1} closing prices, got ` +
          `${closes.length}).`,
      );
    }

    const rounded = Number(rsi.toFixed(2));
    return {
      symbol: normalized,
      rsi: rounded,
      status: this.classify(rounded),
    };
  }

  /**
   * Compute a combined technical-analysis snapshot (RSI, moving averages, and
   * MACD) for a symbol from a single pull of its closing prices.
   */
  async getTechnicalAnalysis(symbol: string): Promise<TechnicalAnalysis> {
    const normalized = symbol.trim().toUpperCase();

    // One candle fetch feeds every indicator. Pull well beyond the longest
    // look-back so EMA/MACD smoothing settles to values consistent with common
    // charting tools (same rationale as the RSI endpoint).
    const lookback = Math.max(SMA_LONG, EMA_LONG) * 5;
    const candles = await this.marketService.getCandles(normalized, lookback);
    const closes = candles.map((candle) => candle.close);

    const rsi = calculateRsi(closes, RSI_PERIOD);
    const sma20 = calculateSma(closes, SMA_SHORT);
    const sma50 = calculateSma(closes, SMA_LONG);
    const ema20 = calculateEma(closes, EMA_SHORT);
    const ema50 = calculateEma(closes, EMA_LONG);
    const macd = calculateMacd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);

    // Every indicator returns null on insufficient history; fail as a unit so
    // the response shape stays fully populated.
    if (
      rsi === null ||
      sma20 === null ||
      sma50 === null ||
      ema20 === null ||
      ema50 === null ||
      macd === null
    ) {
      throw new UnprocessableEntityException(
        `Not enough price history to compute the full technical analysis for ` +
          `"${normalized}" (need at least ${Math.max(SMA_LONG, EMA_LONG)} ` +
          `closing prices, got ${closes.length}).`,
      );
    }

    const rsiValue = this.round2(rsi);
    const movingAverages: MovingAverages = {
      sma20: this.round2(sma20),
      sma50: this.round2(sma50),
      ema20: this.round2(ema20),
      ema50: this.round2(ema50),
    };

    return {
      symbol: normalized,
      rsi: { value: rsiValue, status: this.classify(rsiValue) },
      movingAverages,
      macd: {
        value: this.round2(macd.macd),
        signal: this.round2(macd.signal),
        histogram: this.round2(macd.histogram),
      },
    };
  }

  /** Boundaries (30 and 70) fall in NEUTRAL, per the spec. */
  private classify(rsi: number): RsiStatus {
    if (rsi < 30) return RsiStatus.Oversold;
    if (rsi > 70) return RsiStatus.Overbought;
    return RsiStatus.Neutral;
  }

  /** Round to 2 decimals for a stable, presentation-ready API response. */
  private round2(value: number): number {
    return Number(value.toFixed(2));
  }
}
