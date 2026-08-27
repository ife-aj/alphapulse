import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetQuotesQueryDto } from './get-quotes.query.dto';
import { MAX_SYMBOLS } from '../validation/symbol.validation';

/**
 * Mirror how the global ValidationPipe processes a query DTO: run the
 * class-transformer @Transform first, then class-validator's constraints.
 */
async function validateQuery(query: Record<string, unknown>) {
  const dto = plainToInstance(GetQuotesQueryDto, query);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('GetQuotesQueryDto', () => {
  it('leaves symbols undefined when the param is omitted (defaults apply)', async () => {
    const { dto, errors } = await validateQuery({});
    expect(errors).toHaveLength(0);
    expect(dto.symbols).toBeUndefined();
  });

  it('parses and normalizes a comma-separated list', async () => {
    const { dto, errors } = await validateQuery({
      symbols: 'aapl, msft ,BRK.B',
    });
    expect(errors).toHaveLength(0);
    expect(dto.symbols).toEqual(['AAPL', 'MSFT', 'BRK.B']);
  });

  it('rejects an explicitly empty ?symbols= value', async () => {
    const { dto, errors } = await validateQuery({ symbols: '' });
    // Explicit-but-empty differs from omitted: it normalizes to [] and fails.
    expect(dto.symbols).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayNotEmpty');
  });

  it('rejects a list that exceeds MAX_SYMBOLS', async () => {
    const symbols = Array.from({ length: MAX_SYMBOLS + 1 }, () => 'AAPL').join(
      ',',
    );
    const { errors } = await validateQuery({ symbols });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
  });

  it('accepts a list exactly at the MAX_SYMBOLS limit', async () => {
    const symbols = Array.from({ length: MAX_SYMBOLS }, () => 'AAPL').join(',');
    const { errors } = await validateQuery({ symbols });
    expect(errors).toHaveLength(0);
  });

  it('rejects a list containing an invalid ticker', async () => {
    const { errors } = await validateQuery({ symbols: 'AAPL,BRK/B' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('matches');
  });
});
