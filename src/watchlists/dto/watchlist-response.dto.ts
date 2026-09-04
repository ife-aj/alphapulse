import { ApiProperty } from '@nestjs/swagger';

/** A single symbol inside a watchlist. */
export class WatchlistItemDto {
  @ApiProperty({ description: 'Watchlist item UUID.' })
  id: string;

  @ApiProperty({ example: 'AAPL', description: 'Uppercase stock symbol.' })
  symbol: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  updatedAt: string;
}

/** A user-owned watchlist. `items` is present on GET /api/watchlists only. */
export class WatchlistDto {
  @ApiProperty({ description: 'Watchlist UUID.' })
  id: string;

  @ApiProperty({ example: 'Tech Stocks' })
  name: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  updatedAt: string;

  @ApiProperty({
    type: WatchlistItemDto,
    isArray: true,
    required: false,
    description: 'The watchlist items, present on GET /api/watchlists.',
  })
  items?: WatchlistItemDto[];
}

/** Response body for GET /api/watchlists. */
export class WatchlistsResponseDto {
  @ApiProperty({ type: WatchlistDto, isArray: true })
  watchlists: WatchlistDto[];
}
