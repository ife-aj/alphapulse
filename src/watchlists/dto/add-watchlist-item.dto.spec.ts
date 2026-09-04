import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddWatchlistItemDto } from './add-watchlist-item.dto';

/**
 * Mirror how the global ValidationPipe processes a body DTO: run the
 * class-transformer @Transform first, then class-validator's constraints.
 */
async function validateSymbol(symbol: unknown) {
  const dto = plainToInstance(AddWatchlistItemDto, { symbol });
  const errors = await validate(dto);
  return { dto, errors };
}

describe('AddWatchlistItemDto', () => {
  it('normalizes lower-case input to uppercase', async () => {
    const { dto, errors } = await validateSymbol('  aapl  ');
    expect(errors).toHaveLength(0);
    expect((dto as { symbol: string }).symbol).toBe('AAPL');
  });

  it('accepts an already-normalized symbol', async () => {
    const { errors } = await validateSymbol('AAPL');
    expect(errors).toHaveLength(0);
  });

  it('accepts a dotted class share', async () => {
    const { dto, errors } = await validateSymbol('brk.b');
    expect(errors).toHaveLength(0);
    expect((dto as { symbol: string }).symbol).toBe('BRK.B');
  });

  it.each(['     ', ''])('rejects a %j symbol', async (symbol) => {
    const { errors } = await validateSymbol(symbol);
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(['BRK/B', 'BRK-B', 'AAP1', 'TOOLONG', 'A@PL'])(
    'rejects an invalid symbol %j',
    async (symbol) => {
      const { errors } = await validateSymbol(symbol);
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it('rejects a missing symbol', async () => {
    const { errors } = await validateSymbol(undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-string symbol', async () => {
    const { errors } = await validateSymbol(123);
    expect(errors.length).toBeGreaterThan(0);
  });
});
