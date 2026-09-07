import { ApiProperty } from '@nestjs/swagger';

/**
 * Live valuation of one holding.
 *
 * Every financial decimal in a valuation is a JSON string — never a JS number —
 * so consumers never inherit binary-float artifacts. Two distinct forms appear:
 *
 *  - **Stored/source decimals** are exact canonical strings with no trailing
 *    zeros: `quantity`, `averagePurchasePrice`, and `currentPrice`. `currentPrice`
 *    is the exact provider price the calculations used — it is never rounded, so
 *    `quantity × currentPrice` reproduces `currentValue` exactly (e.g.
 *    12.5 × "182.7465" = "2284.33"). Do NOT round it to cents.
 *  - **Calculated money/percentage outputs** are rounded strings with two decimal
 *    places: `investedValue`, `currentValue`, `profitLoss`, and `returnPercentage`.
 *    Computations themselves use the exact values (see valuation.service);
 *    rounding happens solely when these strings are built.
 */
export class HoldingValuationDto {
  @ApiProperty({ example: 'AAPL', description: 'Uppercase stock symbol.' })
  symbol: string;

  @ApiProperty({ example: '12.5', description: 'Exact quantity (canonical).' })
  quantity: string;

  @ApiProperty({
    example: '152.3755',
    description: 'Average purchase price per share, exact (canonical).',
  })
  averagePurchasePrice: string;

  @ApiProperty({
    example: '182.7465',
    description:
      'Current price per share from the live quote — the exact provider value, ' +
      'serialized as a canonical decimal string (never rounded).',
  })
  currentPrice: string;

  @ApiProperty({
    example: '1904.69',
    description: 'Cost basis = quantity × average purchase price (money, 2 dp).',
  })
  investedValue: string;

  @ApiProperty({
    example: '2284.33',
    description:
      'Current value = quantity × exact current price (money, 2 dp).',
  })
  currentValue: string;

  @ApiProperty({
    example: '379.64',
    description: 'Profit/loss = current value − cost basis (money, 2 dp).',
  })
  profitLoss: string;

  @ApiProperty({
    example: '19.93',
    description: 'Return on cost basis, as a percentage (2 dp).',
  })
  returnPercentage: string;
}

/**
 * Response body for GET /api/portfolios/:id/valuation.
 *
 * Totals are the exact sum of the per-holding exact values, rounded once when
 * these strings are built — never the sum of already-rounded rows — so a listed
 * total may differ from naively adding the rounded per-holding rows by one cent;
 * the totals are authoritative.
 */
export class PortfolioValuationDto {
  @ApiProperty({ description: 'Portfolio UUID.' })
  portfolioId: string;

  @ApiProperty({
    example: '31802.00',
    description: 'Total cost basis across holdings (money, 2 dp).',
  })
  totalInvestedValue: string;

  @ApiProperty({
    example: '38129.00',
    description: 'Total current value across holdings (money, 2 dp).',
  })
  totalCurrentValue: string;

  @ApiProperty({
    example: '6327.00',
    description: 'Total profit/loss across holdings (money, 2 dp).',
  })
  totalProfitLoss: string;

  @ApiProperty({
    example: '19.90',
    description: 'Total return on cost basis, as a percentage (2 dp).',
  })
  totalReturnPercentage: string;

  @ApiProperty({
    type: HoldingValuationDto,
    isArray: true,
    description: 'Per-holding valuation lines.',
  })
  holdings: HoldingValuationDto[];
}
