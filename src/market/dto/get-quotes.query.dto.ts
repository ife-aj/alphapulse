import { IsOptional, IsString } from 'class-validator';

export class GetQuotesQueryDto {
  /**
   * Optional comma-separated tickers, e.g. ?symbols=AAPL,MSFT
   * When omitted, all available quotes are returned.
   */
  @IsOptional()
  @IsString()
  symbols?: string;
}
