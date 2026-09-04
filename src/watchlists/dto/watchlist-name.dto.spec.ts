import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWatchlistDto } from './create-watchlist.dto';
import { UpdateWatchlistDto } from './update-watchlist.dto';

/**
 * Mirror how the global ValidationPipe processes a body DTO: run the
 * class-transformer @Transform first, then class-validator's constraints.
 */
async function validateName(
  Dto: typeof CreateWatchlistDto | typeof UpdateWatchlistDto,
  name: unknown,
) {
  const dto = plainToInstance(Dto, { name });
  const errors = await validate(dto);
  return { dto, errors };
}

const NAME_DTOS = [CreateWatchlistDto, UpdateWatchlistDto];

describe('watchlist name DTOs', () => {
  it.each(NAME_DTOS)('%s trims surrounding whitespace', async (Dto) => {
    const { dto, errors } = await validateName(Dto, '  Tech Stocks  ');
    expect(errors).toHaveLength(0);
    expect((dto as { name: string }).name).toBe('Tech Stocks');
  });

  it.each(NAME_DTOS)('%s rejects a whitespace-only name', async (Dto) => {
    const { errors } = await validateName(Dto, '     ');
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(NAME_DTOS)('%s rejects an empty string', async (Dto) => {
    const { errors } = await validateName(Dto, '');
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(NAME_DTOS)('%s rejects a missing name', async (Dto) => {
    const { errors } = await validateName(Dto, undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(NAME_DTOS)(
    '%s rejects a name longer than 100 characters',
    async (Dto) => {
      const { errors } = await validateName(Dto, 'T'.repeat(101));
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(NAME_DTOS)(
    '%s accepts a name at exactly 100 characters',
    async (Dto) => {
      const { errors } = await validateName(Dto, 'T'.repeat(100));
      expect(errors).toHaveLength(0);
    },
  );

  it.each(NAME_DTOS)('%s rejects a non-string name', async (Dto) => {
    const { errors } = await validateName(Dto, 42);
    expect(errors.length).toBeGreaterThan(0);
  });
});
