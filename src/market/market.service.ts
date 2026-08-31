import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { AxiosInstance } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Candle, Quote, Signal, SignalAction } from './market.types';
import {
  malformedProviderResponseException,
  toProviderBodyHttpException,
  toProviderHttpException,
  unknownSymbolException,
} from './provider-errors';

const FALLBACK_SYMBOLS = 'AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL';
const DEFAULT_CANDLE_DAYS = 30;

/** DI token for the Twelve Data axios client, kept separate from the Finnhub HttpService. */
export const TWELVE_DATA_HTTP = 'TWELVE_DATA_HTTP';

/** Raw shape returned by Finnhub's GET /quote endpoint. */
interface FinnhubQuoteResponse {
  c: number; // current price
  d: number | null; // change
  dp: number | null; // percent change
  h: number; // day high
  l: number; // day low
  o: number; // day open
  pc: number; // previous close
  t: number; // unix timestamp (seconds)
}

/** Raw shape returned by Twelve Data's GET /time_series endpoint. */
interface TwelveDataValue {
  datetime: string; // "2024-01-03" for the 1day interval
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface TwelveDataTimeSeriesResponse {
  values?: TwelveDataValue[];
  status: 'ok' | 'error';
  code?: number; // present only when status === 'error'
  message?: string;
}

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    @Inject(TWELVE_DATA_HTTP) private readonly twelveData: AxiosInstance,
  ) {}

  async getQuotes(symbols?: string[]): Promise<Quote[]> {
    const targets =
      symbols && symbols.length > 0 ? symbols : this.getDefaultSymbols();
    // One Finnhub /quote call per symbol; all-or-nothing on failure.
    return Promise.all(targets.map((symbol) => this.fetchQuote(symbol)));
  }

  async getSignal(symbol: string): Promise<Signal> {
    const quote = await this.fetchQuote(symbol);
    return this.deriveSignal(quote);
  }

  /** Fetch `days` of daily OHLCV candles for a symbol, oldest-first. */
  async getCandles(
    symbol: string,
    days: number = DEFAULT_CANDLE_DAYS,
  ): Promise<Candle[]> {
    const normalized = symbol.trim().toUpperCase();
    const startedAt = Date.now();

    let payload: unknown;
    try {
      const response = await this.twelveData.get('/time_series', {
        params: {
          symbol: normalized,
          interval: '1day',
          outputsize: days,
          apikey: this.config.get<string>('TWELVE_DATA_API_KEY') ?? '',
        },
      });
      payload = response.data;
    } catch (error) {
      const exception = toProviderHttpException(error, { symbol: normalized });
      this.logProviderFailure(exception, 'Twelve Data', normalized, startedAt);
      throw exception;
    }

    if (!this.isTwelveDataResponse(payload)) {
      this.logger.error(
        `Twelve Data returned a malformed response for ${normalized} (unexpected payload shape)`,
      );
      throw malformedProviderResponseException();
    }

    // Twelve Data reports bad symbols, plan limits, and rate limits as HTTP 200 + status:'error'.
    if (payload.status === 'error') {
      const exception = toProviderBodyHttpException(payload, {
        symbol: normalized,
      });
      this.logProviderFailure(exception, 'Twelve Data', normalized, startedAt);
      throw exception;
    }

    // A valid response with no candles means there is no market data at all.
    const values = payload.values;
    if (!values || values.length === 0) {
      this.logger.debug(
        `Twelve Data returned no candles for ${normalized}; treating as unknown symbol`,
      );
      throw unknownSymbolException(normalized);
    }

    const candles = this.mapCandles(values);
    this.logger.debug(
      `Fetched ${candles.length} candles for ${normalized} (${days}d) in ${Date.now() - startedAt}ms`,
    );
    return candles;
  }

  /** Structural guard on the raw Twelve Data payload before we trust it. */
  private isTwelveDataResponse(
    value: unknown,
  ): value is TwelveDataTimeSeriesResponse {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v.status !== 'ok' && v.status !== 'error') return false;
    if (v.status === 'ok') {
      // `values` is optional; when present it must be an array of candles whose
      // OHLCV fields are strings (Twelve Data's wire format).
      if (v.values !== undefined && !Array.isArray(v.values)) return false;
      if (
        Array.isArray(v.values) &&
        !v.values.every((candle) => this.isTwelveDataCandle(candle))
      ) {
        return false;
      }
    }
    return true;
  }

  private isTwelveDataCandle(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return ['datetime', 'open', 'high', 'low', 'close', 'volume'].every(
      (key) => typeof v[key] === 'string',
    );
  }

  private mapCandles(values: TwelveDataValue[]): Candle[] {
    // Twelve Data returns newest-first; reverse to chronological (oldest-first) order.
    return values.map((candle) => this.toCandle(candle)).reverse();
  }

  private toCandle(v: TwelveDataValue): Candle {
    const open = Number(v.open);
    const high = Number(v.high);
    const low = Number(v.low);
    const close = Number(v.close);
    const volume = Number(v.volume);

    // A non-numeric OHLCV field means the provider sent something we can't
    // interpret; fail loudly rather than leaking NaN into the response.
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      this.logger.error(
        `Twelve Data returned a malformed candle for ${v.datetime} (non-numeric OHLCV)`,
      );
      throw malformedProviderResponseException();
    }

    return { date: v.datetime, open, high, low, close, volume };
  }

  private getDefaultSymbols(): string[] {
    const raw = this.config.get<string>('DEFAULT_SYMBOLS') ?? FALLBACK_SYMBOLS;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async fetchQuote(symbol: string): Promise<Quote> {
    const normalized = symbol.trim().toUpperCase();
    const startedAt = Date.now();

    let data: unknown;
    try {
      const response = await firstValueFrom(
        this.http.get('/quote', {
          params: { symbol: normalized },
        }),
      );
      data = response.data;
    } catch (error) {
      const exception = toProviderHttpException(error, { symbol: normalized });
      this.logProviderFailure(exception, 'Finnhub', normalized, startedAt);
      throw exception;
    }

    if (!this.isFinnhubQuote(data)) {
      this.logger.error(
        `Finnhub returned a malformed response for ${normalized} (unexpected quote shape)`,
      );
      throw malformedProviderResponseException();
    }

    // Finnhub answers unknown symbols with HTTP 200 + all-zero fields, not a 404.
    if (data.c === 0 && data.t === 0) {
      this.logger.debug(
        `Finnhub returned an all-zero quote for ${normalized}; treating as unknown symbol`,
      );
      throw unknownSymbolException(normalized);
    }

    const quote = this.mapQuote(normalized, data);
    this.logger.debug(
      `Fetched quote for ${normalized} in ${Date.now() - startedAt}ms`,
    );
    return quote;
  }

  /** Structural + numeric guard on the raw Finnhub payload before we trust it. */
  private isFinnhubQuote(value: unknown): value is FinnhubQuoteResponse {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.c === 'number' &&
      Number.isFinite(v.c) &&
      typeof v.t === 'number' &&
      Number.isFinite(v.t) &&
      (typeof v.d === 'number' || v.d === null) &&
      (typeof v.dp === 'number' || v.dp === null)
    );
  }

  private mapQuote(symbol: string, data: FinnhubQuoteResponse): Quote {
    // Finnhub `t` is in seconds. Guard the range so an out-of-range value can
    // never escape the translation layer as a RangeError from toISOString().
    const timestamp = data.t * 1000;
    if (Math.abs(timestamp) > 8_640_000_000_000_000) {
      this.logger.error(
        `Finnhub returned an out-of-range timestamp for ${symbol}`,
      );
      throw malformedProviderResponseException();
    }

    return {
      symbol,
      price: data.c,
      change: data.d ?? 0,
      changePercent: data.dp ?? 0,
      timestamp: new Date(timestamp).toISOString(),
    };
  }

  /**
   * Log a provider failure at a level matched to its AlphaPulse status:
   * 404 (expected unknown symbol / empty data) -> debug; 500 (credential or
   * config problem) -> error; 429/502/503/504 (recoverable upstream
   * conditions) -> warn. The raw Axios error is never logged — it can carry
   * the provider URL and API key.
   */
  private logProviderFailure(
    exception: HttpException,
    provider: string,
    symbol: string,
    startedAt: number,
  ): void {
    const elapsedMs = Date.now() - startedAt;
    const status = exception.getStatus();
    const detail = `Upstream ${provider} request for ${symbol} failed (${status}) after ${elapsedMs}ms`;

    if (status === HttpStatus.NOT_FOUND) {
      this.logger.debug(detail);
    } else if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(detail);
    } else {
      this.logger.warn(detail);
    }
  }

  /** Naive placeholder strategy: act on the latest percentage move. */
  private deriveSignal(quote: Quote): Signal {
    let action = SignalAction.Hold;
    if (quote.changePercent >= 1) action = SignalAction.Buy;
    else if (quote.changePercent <= -1) action = SignalAction.Sell;

    const score = Math.max(-1, Math.min(1, quote.changePercent / 3));

    return {
      symbol: quote.symbol,
      action,
      score: Number(score.toFixed(2)),
      rationale: `Derived from a ${quote.changePercent}% move on the latest quote.`,
      generatedAt: new Date().toISOString(),
    };
  }
}
