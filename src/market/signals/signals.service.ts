import { Injectable } from '@nestjs/common';
import { IndicatorsService } from '../indicators/indicators.service';
import { evaluateSignal } from './signal.calculator';
import type { SignalResult } from './signal.types';

@Injectable()
export class SignalsService {
  constructor(private readonly indicatorsService: IndicatorsService) {}

  /**
   * Generate an explainable technical-analysis signal for a symbol.
   *
   * The signal engine does no data fetching of its own: it asks
   * IndicatorsService for the already-computed technical-analysis snapshot
   * (which owns the candle / Twelve Data pipeline) and scores that snapshot
   * with the pure {@link evaluateSignal} calculator.
   */
  async getSignal(symbol: string): Promise<SignalResult> {
    const analysis = await this.indicatorsService.getTechnicalAnalysis(symbol);
    return evaluateSignal(analysis);
  }
}
