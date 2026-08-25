import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketService } from './market.service';
import { GetQuotesQueryDto } from './dto/get-quotes.query.dto';
import { GetCandlesQueryDto } from './dto/get-candles.query.dto';
import type { Candle, Quote, Signal } from './market.types';

@Controller('market')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Get('quotes')
  getQuotes(@Query() query: GetQuotesQueryDto): Promise<Quote[]> {
    const symbols = query.symbols
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.marketService.getQuotes(symbols);
  }

  @Get('signals/:symbol')
  getSignal(@Param('symbol') symbol: string): Promise<Signal> {
    return this.marketService.getSignal(symbol);
  }

  @Get('candles/:symbol')
  getCandles(
    @Param('symbol') symbol: string,
    @Query() query: GetCandlesQueryDto,
  ): Promise<Candle[]> {
    return this.marketService.getCandles(symbol, query.days);
  }
}
