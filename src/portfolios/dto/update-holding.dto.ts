import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptionalPositiveFixedDecimal } from '../validation/positive-fixed-decimal.validator';

/**
 * Request body for PATCH /api/portfolios/:id/holdings/:symbol.
 *
 * Either or both of `quantity` / `averagePurchasePrice` may be sent — this is a
 * partial update — but an empty body is rejected (the service refuses a patch
 * that changes nothing, returning 400).
 *
 * Both fields use `IsOptionalPositiveFixedDecimal`, which skips only a truly
 * absent value (`undefined`). `null` is deliberately NOT treated as absent: it,
 * like `NaN`, `Infinity`, zero, negatives, over-large magnitudes, and values
 * with more than six decimal places, is rejected with a 400.
 */
export class UpdateHoldingDto {
  @ApiPropertyOptional({
    example: 15,
    description:
      'New quantity owned. When provided, a finite number greater than 0 ' +
      'with at most 12 integer digits and 6 decimal places.',
  })
  @IsOptionalPositiveFixedDecimal()
  quantity?: number;

  @ApiPropertyOptional({
    example: 160.25,
    description:
      'New average purchase price per share in USD. When provided, a finite ' +
      'number greater than 0 with at most 12 integer digits and 6 decimal places.',
  })
  @IsOptionalPositiveFixedDecimal()
  averagePurchasePrice?: number;
}
