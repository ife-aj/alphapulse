import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request body for POST /api/portfolios and PATCH /api/portfolios/:id
 * (portfolio rename is a full name replacement, matching the watchlist rename
 * contract).
 *
 * `name` is trimmed before validation, so whitespace-only names are rejected and
 * the stored value is already trimmed — matching what the migration's CHECK
 * constraint and the `(user_id, lower(btrim(name)))` unique index expect.
 */
export class PortfolioNameDto {
  @ApiProperty({
    example: 'Tech Holdings',
    minLength: 1,
    maxLength: 100,
    description:
      'Portfolio name. Trimmed of surrounding whitespace; must be ' +
      '1–100 characters and contain at least one non-whitespace character.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'name must be a string' })
  @IsNotEmpty({ message: 'name is required' })
  @MinLength(1, { message: 'name must be at least 1 character long' })
  @MaxLength(100, { message: 'name must be at most 100 characters long' })
  name: string;
}
