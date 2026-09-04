import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import {
  normalizeSymbol,
  SYMBOL_FORMAT_HINT,
  SYMBOL_REGEX,
} from '../../market/validation/symbol.validation';

/**
 * Request body for POST /api/watchlists/:id/items.
 *
 * `symbol` is normalized (trimmed, uppercased) before validation, so `aapl` and
 * `AAPL` insert the same stored value the migration expects (uppercase) and the
 * unique `(watchlist_id, symbol)` index treats them as the same symbol.
 */
export class AddWatchlistItemDto {
  @ApiProperty({
    example: 'AAPL',
    description: `Stock symbol. Trimmed and uppercased. ${SYMBOL_FORMAT_HINT}`,
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSymbol(value) : value,
  )
  @IsString({ message: 'symbol must be a string' })
  @IsNotEmpty({ message: 'symbol is required' })
  @Matches(SYMBOL_REGEX, {
    message: `symbol is invalid. ${SYMBOL_FORMAT_HINT}`,
  })
  symbol: string;
}
