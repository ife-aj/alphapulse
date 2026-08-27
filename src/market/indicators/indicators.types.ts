/** Momentum classification derived from an RSI reading. */
export enum RsiStatus {
  Oversold = 'OVERSOLD', // RSI < 30
  Neutral = 'NEUTRAL', // 30 <= RSI <= 70
  Overbought = 'OVERBOUGHT', // RSI > 70
}

/** Response shape for GET /api/market/indicators/rsi/:symbol. */
export interface RsiResult {
  symbol: string;
  rsi: number; // 0..100, rounded to 2 decimals
  status: RsiStatus;
}

/** RSI reading nested inside the combined technical-analysis response. */
export interface RsiSummary {
  value: number; // 0..100, rounded to 2 decimals
  status: RsiStatus;
}

/** Latest simple and exponential moving averages, rounded to 2 decimals. */
export interface MovingAverages {
  sma20: number;
  sma50: number;
  ema20: number;
  ema50: number;
}

/** Latest MACD components (12/26/9), rounded to 2 decimals. */
export interface MacdSummary {
  value: number; // MACD line
  signal: number;
  histogram: number;
}

/** Response shape for GET /api/market/indicators/:symbol. */
export interface TechnicalAnalysis {
  symbol: string;
  rsi: RsiSummary;
  movingAverages: MovingAverages;
  macd: MacdSummary;
}
