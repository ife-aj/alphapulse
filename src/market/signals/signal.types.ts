/** Discrete trading signal derived from the aggregate indicator score. */
export enum SignalType {
  Buy = 'BUY',
  WeakBuy = 'WEAK_BUY',
  Hold = 'HOLD',
  WeakSell = 'WEAK_SELL',
  Sell = 'SELL',
}

/** Response shape for GET /api/market/signals/:symbol. */
export interface SignalResult {
  symbol: string;
  signal: SignalType;
  score: number; // -100..+100: sum of the four indicator votes (each ±25)
  confidence: number; // 0..100: how strongly the indicators agree with `signal`
  reasons: string[]; // one human-readable explanation per indicator
}
