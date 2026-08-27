import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  Matches,
} from 'class-validator';
import {
  MAX_SYMBOLS,
  parseSymbolList,
  SYMBOL_FORMAT_HINT,
  SYMBOL_REGEX,
} from '../validation/symbol.validation';

export class GetQuotesQueryDto {
  /**
   * Optional comma-separated tickers, e.g. ?symbols=AAPL,MSFT,BRK.B
   *
   * - Omitted entirely -> undefined -> the service returns the default symbols.
   * - Sent but empty (?symbols=) -> [] -> rejected by @ArrayNotEmpty (400).
   *
   * The @Transform parses and normalizes the raw value into a ticker array
   * here, so the controller never has to split or clean the input itself.
   */
  @IsOptional()
  @Transform(({ value }) => parseSymbolList(value))
  @IsArray()
  @ArrayNotEmpty({ message: 'symbols must contain at least one ticker.' })
  @ArrayMaxSize(MAX_SYMBOLS, {
    message: `symbols cannot contain more than ${MAX_SYMBOLS} tickers.`,
  })
  @Matches(SYMBOL_REGEX, {
    each: true,
    message: `symbols contains an invalid ticker. ${SYMBOL_FORMAT_HINT}`,
  })
  symbols?: string[];
}
