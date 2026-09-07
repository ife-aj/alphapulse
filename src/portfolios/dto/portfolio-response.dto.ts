import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single holding inside a portfolio.
 *
 * `quantity` and `averagePurchasePrice` are the stored `numeric(18,6)` cells
 * echoed back as exact decimal strings (canonical, no trailing zeros) so no
 * value ever round-trips through a JS float on the wire.
 */
export class HoldingDto {
  @ApiProperty({ description: 'Holding UUID.' })
  id: string;

  @ApiProperty({ example: 'AAPL', description: 'Uppercase stock symbol.' })
  symbol: string;

  @ApiProperty({ example: '12.5', description: 'Exact quantity (canonical).' })
  quantity: string;

  @ApiProperty({
    example: '152.3755',
    description: 'Average purchase price per share, exact (canonical).',
  })
  averagePurchasePrice: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  updatedAt: string;
}

/** A user-owned portfolio (the shape on POST/GET-list/PATCH). */
export class PortfolioDto {
  @ApiProperty({ description: 'Portfolio UUID.' })
  id: string;

  @ApiProperty({ example: 'Tech Holdings' })
  name: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-04T10:00:00.000Z' })
  updatedAt: string;
}

/** Response body for GET /api/portfolios. */
export class PortfoliosResponseDto {
  @ApiProperty({ type: PortfolioDto, isArray: true })
  portfolios: PortfolioDto[];
}

/** Response body for GET /api/portfolios/:id (portfolio + its holdings). */
export class PortfolioDetailDto extends PortfolioDto {
  @ApiProperty({
    type: HoldingDto,
    isArray: true,
    description: 'Holdings in this portfolio, ordered by symbol.',
  })
  holdings: HoldingDto[];
}
