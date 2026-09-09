import Decimal from 'decimal.js';
import { computePortfolioValuation } from './valuation-computation';
import type { PricedValuationHolding } from './valuation-computation';

const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';

/** Build a priced holding from decimal strings, as the loader + market produce them. */
function priced(
  symbol: string,
  quantity: number | string,
  averagePurchasePrice: number | string,
  currentPrice: number | string,
): PricedValuationHolding {
  return {
    symbol,
    quantity: new Decimal(quantity),
    averagePurchasePrice: new Decimal(averagePurchasePrice),
    currentPrice: new Decimal(currentPrice),
  };
}

describe('computePortfolioValuation', () => {
  it('returns the exact zero DTO for an empty portfolio', () => {
    expect(computePortfolioValuation(PORTFOLIO_ID, [])).toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '0.00',
      totalCurrentValue: '0.00',
      totalProfitLoss: '0.00',
      totalReturnPercentage: '0.00',
      holdings: [],
    });
  });

  it('preserves the exact provider price and money-rounds only the calculated figure (10 × 182.7465)', () => {
    // Exact math: 10 × 182.7465 = 1827.465 → "1827.47" (had the price been
    // rounded to cents first, this would read 1827.50).
    expect(
      computePortfolioValuation(PORTFOLIO_ID, [
        priced('AAPL', 10, '100', '182.7465'),
      ]),
    ).toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '1000.00',
      totalCurrentValue: '1827.47',
      totalProfitLoss: '827.47',
      totalReturnPercentage: '82.75',
      holdings: [
        {
          symbol: 'AAPL',
          quantity: '10',
          averagePurchasePrice: '100',
          currentPrice: '182.7465',
          investedValue: '1000.00',
          currentValue: '1827.47',
          profitLoss: '827.47',
          returnPercentage: '82.75',
        },
      ],
    });
  });

  it('derives currentValue from the exact price (12.5 × "182.7465" = "2284.33")', () => {
    expect(
      computePortfolioValuation(PORTFOLIO_ID, [
        priced('AAPL', '12.5', '150', '182.7465'),
      ]),
    ).toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '1875.00',
      totalCurrentValue: '2284.33',
      totalProfitLoss: '409.33',
      totalReturnPercentage: '21.83',
      holdings: [
        {
          symbol: 'AAPL',
          quantity: '12.5',
          averagePurchasePrice: '150',
          // Exact, unrounded provider price — NOT forced to two decimals.
          currentPrice: '182.7465',
          investedValue: '1875.00',
          // Calculated from the exact price (12.5 × 182.7465 = 2284.33125),
          // rounded only at serialization to two decimals.
          currentValue: '2284.33',
          profitLoss: '409.33',
          returnPercentage: '21.83',
        },
      ],
    });
  });

  it('echoes quantity, average purchase price, and current price as canonical strings', () => {
    // Decimals normalize trailing zeros at construction ("12.500000" → "12.5"),
    // exactly as the loader normalizes numeric DB cells.
    const dto = computePortfolioValuation(PORTFOLIO_ID, [
      priced('AAPL', '12.500000', '152.375500', '182.746500'),
    ]);
    expect(dto.holdings[0]).toMatchObject({
      quantity: '12.5',
      averagePurchasePrice: '152.3755',
      currentPrice: '182.7465',
      currentValue: '2284.33',
    });
  });

  it('keeps each supplied holding in its input position (no symbol reordering or deduplication)', () => {
    const dto = computePortfolioValuation(PORTFOLIO_ID, [
      priced('ZZZZ', 2, '10', '50'),
      priced('AAPL', 3, '20', '100'),
      priced('AAPL', 1, '5', '90'),
    ]);
    // The duplicated symbol is valued in each position it appears — never merged.
    expect(dto.holdings.map((h) => h.symbol)).toEqual(['ZZZZ', 'AAPL', 'AAPL']);
    expect(dto.holdings.map((h) => h.currentValue)).toEqual([
      '100.00',
      '300.00',
      '90.00',
    ]);
    expect(dto).toMatchObject({
      totalInvestedValue: '85.00',
      totalCurrentValue: '490.00',
      totalProfitLoss: '405.00',
    });
  });

  it('rounds portfolio totals once from exact sums — never by summing rounded rows', () => {
    const dto = computePortfolioValuation(PORTFOLIO_ID, [
      priced('A', 1, '0', '0.005'),
      priced('B', 1, '0', '0.005'),
    ]);
    // Each holding rounds 0.005 → "0.01", but the authoritative total is the
    // exact sum 0.005 + 0.005 = 0.01 — NOT the sum of the two displayed rows
    // ("0.02"). Totals are rounded once, from the unrounded values.
    expect(dto.holdings.map((h) => h.currentValue)).toEqual(['0.01', '0.01']);
    expect(dto.totalCurrentValue).toBe('0.01');
    expect(dto.totalInvestedValue).toBe('0.00');
    expect(dto.totalProfitLoss).toBe('0.01');
  });

  it('aggregates several holdings with exact per-holding and total profit/loss and percentages', () => {
    // Mirror of the REST oracle: identical numbers flow through the pure phase.
    expect(
      computePortfolioValuation(PORTFOLIO_ID, [
        priced('AAPL', '12.5', '152.3755', '182.75'),
        priced('MSFT', '4', '60', '70'),
      ]),
    ).toEqual({
      portfolioId: PORTFOLIO_ID,
      totalInvestedValue: '2144.69',
      totalCurrentValue: '2564.38',
      totalProfitLoss: '419.68',
      totalReturnPercentage: '19.57',
      holdings: [
        {
          symbol: 'AAPL',
          quantity: '12.5',
          averagePurchasePrice: '152.3755',
          currentPrice: '182.75',
          investedValue: '1904.69',
          currentValue: '2284.38',
          profitLoss: '379.68',
          returnPercentage: '19.93',
        },
        {
          symbol: 'MSFT',
          quantity: '4',
          averagePurchasePrice: '60',
          currentPrice: '70',
          investedValue: '240.00',
          currentValue: '280.00',
          profitLoss: '40.00',
          returnPercentage: '16.67',
        },
      ],
    });
  });

  it('reports "0.00" percentages for a zero-cost base and zero-quantity holdings', () => {
    // Zero average cost: every profit is gain on a zero base → "0.00".
    const zeroCost = computePortfolioValuation(PORTFOLIO_ID, [
      priced('AAPL', '5', '0', '200'),
    ]);
    expect(zeroCost.holdings[0]).toMatchObject({
      investedValue: '0.00',
      currentValue: '1000.00',
      profitLoss: '1000.00',
      returnPercentage: '0.00',
    });
    expect(zeroCost).toMatchObject({
      totalInvestedValue: '0.00',
      totalReturnPercentage: '0.00',
    });

    // Zero quantity: no position to value → all zeros and "0.00" percentages.
    const zeroQuantity = computePortfolioValuation(PORTFOLIO_ID, [
      priced('AAPL', '0', '100', '200'),
    ]);
    expect(zeroQuantity.holdings[0]).toMatchObject({
      investedValue: '0.00',
      currentValue: '0.00',
      profitLoss: '0.00',
      returnPercentage: '0.00',
    });
  });

  it('never mutates its inputs (frozen holdings are safe and results are repeatable)', () => {
    const holdings = Object.freeze([
      Object.freeze(priced('AAPL', 2, '10', '50')),
      Object.freeze(priced('MSFT', 1, '20', '100')),
    ]);
    const snapshot = (): string[][] =>
      holdings.map((h) => [
        h.symbol,
        h.quantity.toString(),
        h.averagePurchasePrice.toString(),
        h.currentPrice.toString(),
      ]);
    const before = snapshot();

    const first = computePortfolioValuation(PORTFOLIO_ID, holdings);
    const second = computePortfolioValuation(PORTFOLIO_ID, holdings);

    expect(second).toEqual(first);
    expect(snapshot()).toEqual(before);
  });

  it('relies on finite Decimals from its callers — the finiteness boundary stays upstream', () => {
    // decimal.js 10 represents NaN/±Infinity as non-finite Decimals instead of
    // throwing, so guarding finiteness must remain where it already is — the 422
    // price validation in valueHoldings and the numeric DB cells — never after
    // construction. The pure function is only ever handed finite Decimals.
    expect(new Decimal(NaN).isFinite()).toBe(false);
    expect(new Decimal(Infinity).isFinite()).toBe(false);
    expect(new Decimal('0.005').isFinite()).toBe(true);
  });
});
