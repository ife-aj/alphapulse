import { IndicatorsService } from '../indicators/indicators.service';
import { RsiStatus } from '../indicators/indicators.types';
import type { TechnicalAnalysis } from '../indicators/indicators.types';
import { SignalsService } from './signals.service';
import { SignalType } from './signal.types';

describe('SignalsService', () => {
  let service: SignalsService;
  let getTechnicalAnalysis: jest.Mock;

  beforeEach(() => {
    getTechnicalAnalysis = jest.fn();
    const indicatorsService = {
      getTechnicalAnalysis,
    } as unknown as IndicatorsService;
    service = new SignalsService(indicatorsService);
  });

  const bullishAnalysis: TechnicalAnalysis = {
    symbol: 'AAPL',
    rsi: { value: 25, status: RsiStatus.Oversold },
    movingAverages: { sma20: 110, sma50: 100, ema20: 110, ema50: 100 },
    macd: { value: 2, signal: 1, histogram: 1 },
  };

  it('delegates to IndicatorsService and scores the returned snapshot', async () => {
    getTechnicalAnalysis.mockResolvedValue(bullishAnalysis);

    const result = await service.getSignal('aapl');

    // Reuses the indicator pipeline once; never touches candles/Twelve Data.
    expect(getTechnicalAnalysis).toHaveBeenCalledTimes(1);
    expect(getTechnicalAnalysis).toHaveBeenCalledWith('aapl');
    expect(result).toEqual({
      symbol: 'AAPL',
      signal: SignalType.Buy,
      score: 100,
      confidence: 100,
      reasons: [
        'RSI is oversold',
        'SMA20 is above SMA50',
        'EMA20 is above EMA50',
        'MACD histogram is positive',
      ],
    });
  });

  it('propagates errors from IndicatorsService (e.g. insufficient history)', async () => {
    getTechnicalAnalysis.mockRejectedValue(new Error('not enough history'));

    await expect(service.getSignal('AAPL')).rejects.toThrow('not enough history');
  });
});
