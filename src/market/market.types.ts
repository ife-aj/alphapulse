export enum SignalAction {
  Buy = 'BUY',
  Hold = 'HOLD',
  Sell = 'SELL',
}

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  timestamp: string;
}

export interface Signal {
  symbol: string;
  action: SignalAction;
  score: number; // -1..1 (negative = bearish, positive = bullish)
  rationale: string;
  generatedAt: string;
}

/** One day of historical price data (OHLCV), ordered oldest-first in a series. */
export interface Candle {
  date: string; // trading day, e.g. "2024-01-03"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
