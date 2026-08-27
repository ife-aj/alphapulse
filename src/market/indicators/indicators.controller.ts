import { Controller, Get, Param } from '@nestjs/common';
import { IndicatorsService } from './indicators.service';
import type { RsiResult, TechnicalAnalysis } from './indicators.types';

@Controller('market/indicators')
export class IndicatorsController {
  constructor(private readonly indicatorsService: IndicatorsService) {}

  @Get('rsi/:symbol')
  getRsi(@Param('symbol') symbol: string): Promise<RsiResult> {
    return this.indicatorsService.getRsi(symbol);
  }

  // Declared after the more specific `rsi/:symbol` route above.
  @Get(':symbol')
  getTechnicalAnalysis(
    @Param('symbol') symbol: string,
  ): Promise<TechnicalAnalysis> {
    return this.indicatorsService.getTechnicalAnalysis(symbol);
  }
}
