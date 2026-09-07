import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import {
  normalizeSymbol,
  SYMBOL_FORMAT_HINT,
  SYMBOL_REGEX,
} from '../../market/validation/symbol.validation';
import { IsPositiveFixedDecimal } from '../validation/positive-fixed-decimal.validator';

/**
 * Request body for POST /api/portfolios/:id/holdings.
 *
 * `symbol` is normalized (trimmed, uppercased) before validation; `quantity` and
 * `averagePurchasePrice` arrive as JSON numbers (within the documented
 * double-safe range) and are validated as exact positive fixed-point decimals
 * (see IsPositiveFixedDecimal). The service canonicalizes them to decimal
 * strings immediately after validation and before they are written to Supabase.
 */
export class CreateHoldingDto {
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

  @ApiProperty({
    example: 12.5,
    description:
      'Quantity owned (supports fractional shares). A finite number greater ' +
      'than 0 with at most 12 integer digits and 6 decimal places.',
  })
  @IsPositiveFixedDecimal()
  quantity: number;

  @ApiProperty({
    example: 152.3755,
    description:
      'Average purchase price per share in USD. A finite number greater than ' +
      '0 with at most 12 integer digits and 6 decimal places.',
  })
  @IsPositiveFixedDecimal()
  averagePurchasePrice: number;
}
