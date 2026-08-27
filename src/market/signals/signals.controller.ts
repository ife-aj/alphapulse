import { Controller, Get, Param } from '@nestjs/common';
import { SignalsService } from './signals.service';
import type { SignalResult } from './signal.types';

@Controller('market/signals')
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  @Get(':symbol')
  getSignal(@Param('symbol') symbol: string): Promise<SignalResult> {
    return this.signalsService.getSignal(symbol);
  }
}
