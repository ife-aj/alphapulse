import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, type AxiosInstance } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Candle, Quote, Signal, SignalAction } from './market.types';

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

    let payload: TwelveDataTimeSeriesResponse;
    try {
      const response = await this.twelveData.get<TwelveDataTimeSeriesResponse>(
        '/time_series',
        {
          params: {
            symbol: normalized,
            interval: '1day',
            outputsize: days,
            apikey: this.config.get<string>('TWELVE_DATA_API_KEY') ?? '',
          },
        },
      );
      payload = response.data;
    } catch (error) {
      throw this.toHttpException(error, normalized, 'Twelve Data');
    }

    // Twelve Data reports bad symbols, plan limits, and rate limits as HTTP 200 + status:'error'.
    if (payload.status === 'error') {
      throw this.toTwelveDataError(payload, normalized);
    }

    return this.mapCandles(payload.values ?? []);
  }

  private mapCandles(values: TwelveDataValue[]): Candle[] {
    // Twelve Data returns newest-first; reverse to chronological (oldest-first) order.
    return values
      .map((v) => ({
        date: v.datetime,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: Number(v.volume),
      }))
      .reverse();
  }

  /** Turn Twelve Data's 200-with-error-body into the right HTTP status for our API. */
  private toTwelveDataError(
    payload: TwelveDataTimeSeriesResponse,
    symbol: string,
  ): HttpException {
    if (payload.code === HttpStatus.TOO_MANY_REQUESTS) {
      return new HttpException(
        'Twelve Data rate limit exceeded. Please retry shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (
      payload.code === HttpStatus.NOT_FOUND ||
      payload.code === HttpStatus.BAD_REQUEST
    ) {
      return new NotFoundException(`No historical data for symbol "${symbol}"`);
    }
    return new ServiceUnavailableException(
      `Failed to fetch candles for "${symbol}" from Twelve Data.`,
    );
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

    let data: FinnhubQuoteResponse;
    try {
      const response = await firstValueFrom(
        this.http.get<FinnhubQuoteResponse>('/quote', {
          params: { symbol: normalized },
        }),
      );
      data = response.data;
    } catch (error) {
      throw this.toHttpException(error, normalized, 'Finnhub');
    }

    // Finnhub answers unknown symbols with HTTP 200 + all-zero fields, not a 404.
    if (data.c === 0 && data.t === 0) {
      throw new NotFoundException(`No market data for symbol "${normalized}"`);
    }

    return this.mapQuote(normalized, data);
  }

  private mapQuote(symbol: string, data: FinnhubQuoteResponse): Quote {
    return {
      symbol,
      price: data.c,
      change: data.d ?? 0,
      changePercent: data.dp ?? 0,
      timestamp: new Date(data.t * 1000).toISOString(), // Finnhub `t` is in seconds
    };
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

  private toHttpException(
    error: unknown,
    symbol: string,
    provider: string,
  ): HttpException {
    if (
      error instanceof AxiosError &&
      error.response?.status === HttpStatus.TOO_MANY_REQUESTS
    ) {
      return new HttpException(
        `${provider} rate limit exceeded. Please retry shortly.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new ServiceUnavailableException(
      `Failed to fetch market data for "${symbol}" from ${provider}.`,
    );
  }
}
