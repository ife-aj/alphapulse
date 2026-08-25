import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, type AxiosInstance, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { MarketService } from './market.service';
import { SignalAction } from './market.types';

// A realistic Finnhub /quote payload; override individual fields per test.
const finnhubQuote = (overrides: Record<string, unknown> = {}) => ({
  c: 100,
  d: 2,
  dp: 2.04,
  h: 101,
  l: 98,
  o: 99,
  pc: 98,
  t: 1582641000,
  ...overrides,
});

const asAxiosResponse = <T>(data: T): AxiosResponse<T> =>
  ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} },
  }) as unknown as AxiosResponse<T>;

// A minimal Twelve Data /time_series payload (newest-first, all-string fields).
const twelveDataSeries = (overrides: Record<string, unknown> = {}) => ({
  meta: { symbol: 'AAPL', interval: '1day' },
  values: [
    {
      datetime: '2024-01-03',
      open: '184.22',
      high: '185.88',
      low: '183.43',
      close: '184.25',
      volume: '58414500',
    },
    {
      datetime: '2024-01-02',
      open: '187.15',
      high: '188.44',
      low: '183.89',
      close: '185.64',
      volume: '82488700',
    },
  ],
  status: 'ok',
  ...overrides,
});

describe('MarketService', () => {
  let service: MarketService;
  let httpGet: jest.Mock;
  let twelveDataGet: jest.Mock;

  beforeEach(() => {
    httpGet = jest.fn();
    twelveDataGet = jest.fn();
    const http = { get: httpGet } as unknown as HttpService;
    const twelveData = { get: twelveDataGet } as unknown as AxiosInstance;
    const config = {
      get: (key: string) =>
        key === 'DEFAULT_SYMBOLS' ? 'AAPL,MSFT' : undefined,
    } as unknown as ConfigService;
    service = new MarketService(http, config, twelveData);
  });

  it('maps a Finnhub quote into our Quote shape', async () => {
    httpGet.mockReturnValue(of(asAxiosResponse(finnhubQuote())));

    const [quote] = await service.getQuotes(['aapl']);

    expect(quote).toEqual({
      symbol: 'AAPL',
      price: 100,
      change: 2,
      changePercent: 2.04,
      timestamp: new Date(1582641000 * 1000).toISOString(),
    });
  });

  it('falls back to DEFAULT_SYMBOLS when none are provided', async () => {
    httpGet.mockReturnValue(of(asAxiosResponse(finnhubQuote())));

    const quotes = await service.getQuotes();

    expect(quotes).toHaveLength(2);
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  it('derives a BUY signal from a strong positive move', async () => {
    httpGet.mockReturnValue(of(asAxiosResponse(finnhubQuote({ dp: 3.2 }))));

    const signal = await service.getSignal('NVDA');

    expect(signal.action).toBe(SignalAction.Buy);
  });

  it('throws NotFoundException for an unknown symbol (zero response)', async () => {
    httpGet.mockReturnValue(
      of(
        asAxiosResponse(
          finnhubQuote({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }),
        ),
      ),
    );

    await expect(service.getSignal('NOPE')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps a Finnhub 429 to a 429 response', async () => {
    const rateLimitError = new AxiosError('Too Many Requests');
    rateLimitError.response = {
      status: HttpStatus.TOO_MANY_REQUESTS,
    } as AxiosResponse;
    httpGet.mockReturnValue(throwError(() => rateLimitError));

    const error = await service.getSignal('AAPL').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('maps a Twelve Data time series into chronological Candle[]', async () => {
    twelveDataGet.mockResolvedValue({ data: twelveDataSeries() });

    const candles = await service.getCandles('aapl', 2);

    expect(twelveDataGet).toHaveBeenCalledWith('/time_series', {
      params: {
        symbol: 'AAPL',
        interval: '1day',
        outputsize: 2,
        apikey: '',
      },
    });
    // Provider returns newest-first; we return oldest-first with numeric fields.
    expect(candles).toEqual([
      {
        date: '2024-01-02',
        open: 187.15,
        high: 188.44,
        low: 183.89,
        close: 185.64,
        volume: 82488700,
      },
      {
        date: '2024-01-03',
        open: 184.22,
        high: 185.88,
        low: 183.43,
        close: 184.25,
        volume: 58414500,
      },
    ]);
  });

  it('throws NotFoundException when Twelve Data reports an unknown symbol', async () => {
    twelveDataGet.mockResolvedValue({
      data: { status: 'error', code: 404, message: 'symbol not found' },
    });

    await expect(service.getCandles('NOPE', 30)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps a Twelve Data 429 error body to a 429 response', async () => {
    twelveDataGet.mockResolvedValue({
      data: { status: 'error', code: 429, message: 'API credits exhausted' },
    });

    const error = await service.getCandles('AAPL', 30).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });
});
