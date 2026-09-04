import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request body for PATCH /api/watchlists/:id (rename). The full new name is
 * required; validation mirrors CreateWatchlistDto (trimmed, non-empty, 1–100).
 */
export class UpdateWatchlistDto {
  @ApiProperty({
    example: 'Growth Stocks',
    minLength: 1,
    maxLength: 100,
    description:
      'New watchlist name. Trimmed of surrounding whitespace; must be ' +
      '1–100 characters and contain at least one non-whitespace character.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'name must be a string' })
  @IsNotEmpty({ message: 'name is required' })
  @MinLength(1, { message: 'name must be at least 1 character long' })
  @MaxLength(100, { message: 'name must be at most 100 characters long' })
  name: string;
}
