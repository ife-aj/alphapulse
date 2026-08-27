import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketService } from './market.service';
import { GetQuotesQueryDto } from './dto/get-quotes.query.dto';
import { GetCandlesQueryDto } from './dto/get-candles.query.dto';
import { ParseSymbolPipe } from './pipes/parse-symbol.pipe';
import type { Candle, Quote } from './market.types';

@Controller('market')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Get('quotes')
  getQuotes(@Query() query: GetQuotesQueryDto): Promise<Quote[]> {
    // Parsing/normalization now lives in the DTO; undefined -> default symbols.
    return this.marketService.getQuotes(query.symbols);
  }

  @Get('candles/:symbol')
  getCandles(
    @Param('symbol', ParseSymbolPipe) symbol: string,
    @Query() query: GetCandlesQueryDto,
  ): Promise<Candle[]> {
    return this.marketService.getCandles(symbol, query.days);
  }
}
