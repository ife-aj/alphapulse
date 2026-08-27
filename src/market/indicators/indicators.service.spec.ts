import { UnprocessableEntityException } from '@nestjs/common';
import { MarketService } from '../market.service';
import { IndicatorsService } from './indicators.service';
import { RsiStatus } from './indicators.types';
import type { Candle } from '../market.types';

// Build a Candle[] from a list of closing prices; other OHLCV fields are
// filler since RSI only reads `close`.
const candlesFromCloses = (closes: number[]): Candle[] =>
  closes.map((close, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));

describe('IndicatorsService', () => {
  let service: IndicatorsService;
  let getCandles: jest.Mock;

  beforeEach(() => {
    getCandles = jest.fn();
    const marketService = { getCandles } as unknown as MarketService;
    service = new IndicatorsService(marketService);
  });

  it('returns NEUTRAL with a rounded RSI for a mixed series', async () => {
    getCandles.mockResolvedValue(
      candlesFromCloses([
        100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108,
        107,
      ]),
    );

    const result = await service.getRsi('aapl');

    expect(result).toEqual({
      symbol: 'AAPL',
      rsi: 66.67,
      status: RsiStatus.Neutral,
    });
  });

  it('flags OVERBOUGHT when prices only rise', async () => {
    getCandles.mockResolvedValue(
      candlesFromCloses(Array.from({ length: 20 }, (_, i) => 100 + i)),
    );

    const result = await service.getRsi('NVDA');

    expect(result.rsi).toBe(100);
    expect(result.status).toBe(RsiStatus.Overbought);
  });

  it('flags OVERSOLD when prices only fall', async () => {
    getCandles.mockResolvedValue(
      candlesFromCloses(Array.from({ length: 20 }, (_, i) => 100 - i)),
    );

    const result = await service.getRsi('TSLA');

    expect(result.rsi).toBe(0);
    expect(result.status).toBe(RsiStatus.Oversold);
  });

  it('treats an RSI of exactly 70 as NEUTRAL (upper boundary)', async () => {
    // 7 gains of +1, 3 losses of -1, 4 flat -> avgGain:avgLoss = 7:3 -> RSI = 70.
    getCandles.mockResolvedValue(
      candlesFromCloses([
        100, 101, 102, 103, 104, 105, 106, 107, 106, 105, 104, 104, 104, 104,
        104,
      ]),
    );

    const result = await service.getRsi('AAPL');

    expect(result.rsi).toBe(70);
    expect(result.status).toBe(RsiStatus.Neutral);
  });

  it('treats an RSI of exactly 30 as NEUTRAL (lower boundary)', async () => {
    // 3 gains of +1, 7 losses of -1, 4 flat -> avgGain:avgLoss = 3:7 -> RSI = 30.
    getCandles.mockResolvedValue(
      candlesFromCloses([
        100, 101, 102, 103, 102, 101, 100, 99, 98, 97, 96, 96, 96, 96, 96,
      ]),
    );

    const result = await service.getRsi('AAPL');

    expect(result.rsi).toBe(30);
    expect(result.status).toBe(RsiStatus.Neutral);
  });

  it('throws 422 when there is not enough candle history', async () => {
    getCandles.mockResolvedValue(candlesFromCloses([100, 101, 102, 103, 104]));

    await expect(service.getRsi('AAPL')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  describe('getTechnicalAnalysis', () => {
    it('assembles a full snapshot from a single candle fetch', async () => {
      // A flat series makes every indicator deterministic: RSI 50 (NEUTRAL),
      // all moving averages equal the price, and MACD collapses to zero.
      getCandles.mockResolvedValue(
        candlesFromCloses(Array.from({ length: 60 }, () => 100)),
      );

      const result = await service.getTechnicalAnalysis('aapl');

      expect(getCandles).toHaveBeenCalledTimes(1);
      expect(result.symbol).toBe('AAPL');
      expect(result.rsi).toEqual({ value: 50, status: RsiStatus.Neutral });
      expect(result.movingAverages).toEqual({
        sma20: 100,
        sma50: 100,
        ema20: 100,
        ema50: 100,
      });
      expect(result.macd.value).toBeCloseTo(0, 2);
      expect(result.macd.signal).toBeCloseTo(0, 2);
      expect(result.macd.histogram).toBeCloseTo(0, 2);
    });

    it('uses distinct windows for the 20- and 50-period averages', async () => {
      // Rising ramp 1..60: last-20 mean = 50.5, last-50 mean = 35.5.
      getCandles.mockResolvedValue(
        candlesFromCloses(Array.from({ length: 60 }, (_, i) => i + 1)),
      );

      const result = await service.getTechnicalAnalysis('MSFT');

      expect(result.movingAverages.sma20).toBe(50.5);
      expect(result.movingAverages.sma50).toBe(35.5);
      // Uptrend: the faster EMA sits above the slower one, MACD line positive,
      // and RSI pins to overbought.
      expect(result.movingAverages.ema20).toBeGreaterThan(
        result.movingAverages.ema50,
      );
      expect(result.macd.value).toBeGreaterThan(0);
      expect(result.rsi.value).toBe(100);
      expect(result.rsi.status).toBe(RsiStatus.Overbought);
    });

    it('rounds every value to 2 decimals', async () => {
      getCandles.mockResolvedValue(
        candlesFromCloses(Array.from({ length: 60 }, (_, i) => i + 1)),
      );

      const result = await service.getTechnicalAnalysis('MSFT');

      const twoDp = (n: number) => Number(n.toFixed(2)) === n;
      expect(twoDp(result.rsi.value)).toBe(true);
      expect(twoDp(result.movingAverages.ema20)).toBe(true);
      expect(twoDp(result.movingAverages.ema50)).toBe(true);
      expect(twoDp(result.macd.value)).toBe(true);
      expect(twoDp(result.macd.signal)).toBe(true);
      expect(twoDp(result.macd.histogram)).toBe(true);
    });

    it('throws 422 when history is too short for the longest indicator', async () => {
      // 30 closes covers RSI/SMA20/EMA20 but not SMA50, EMA50, or MACD.
      getCandles.mockResolvedValue(
        candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i)),
      );

      await expect(service.getTechnicalAnalysis('AAPL')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });
});
