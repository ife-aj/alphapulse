import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateHoldingDto } from './create-holding.dto';

/**
 * Mirror how the global ValidationPipe processes a body DTO: run the
 * class-transformer @Transform first, then class-validator's constraints.
 */
async function validateCreate(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateHoldingDto, body);
  const errors = await validate(dto);
  return { dto, errors };
}

const VALID_BODY = { symbol: 'aapl', quantity: 12.5, averagePurchasePrice: 152.3755 };

describe('CreateHoldingDto', () => {
  describe('symbol', () => {
    it('normalizes lower-case input to uppercase', async () => {
      const { dto, errors } = await validateCreate({ ...VALID_BODY });
      expect(errors).toHaveLength(0);
      expect((dto as { symbol: string }).symbol).toBe('AAPL');
    });

    it('accepts an already-normalized symbol', async () => {
      const { errors } = await validateCreate({ ...VALID_BODY, symbol: 'AAPL' });
      expect(errors).toHaveLength(0);
    });

    it('accepts a dotted class share', async () => {
      const { dto, errors } = await validateCreate({
        ...VALID_BODY,
        symbol: 'brk.b',
      });
      expect(errors).toHaveLength(0);
      expect((dto as { symbol: string }).symbol).toBe('BRK.B');
    });

    it.each(['     ', '', 123, null, undefined])(
      'rejects the non-string/missing symbol %j',
      async (symbol) => {
        const { errors } = await validateCreate({ ...VALID_BODY, symbol });
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it.each(['BRK/B', 'AAP1', 'TOOLONG', 'A@PL'])(
      'rejects an invalid symbol %j',
      async (symbol) => {
        const { errors } = await validateCreate({ ...VALID_BODY, symbol });
        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });

  describe('quantity and averagePurchasePrice', () => {
    it.each([0.5, 12.5, 1, 0.000001, 999999999999])(
      'accepts a valid quantity %p',
      async (quantity) => {
        const { errors } = await validateCreate({ ...VALID_BODY, quantity });
        expect(errors).toHaveLength(0);
      },
    );

    it.each([0, -1, null, undefined, NaN, Infinity, 1.1234567])(
      'rejects the invalid quantity %p',
      async (quantity) => {
        const { errors } = await validateCreate({ ...VALID_BODY, quantity });
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it('rejects a quantity with 13 integer digits (over numeric(18,6))', async () => {
      const { errors } = await validateCreate({
        ...VALID_BODY,
        quantity: 1000000000000,
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it.each([0, -1, null, undefined, NaN, '12.5'])(
      'rejects the invalid averagePurchasePrice %p',
      async (averagePurchasePrice) => {
        const { errors } = await validateCreate({
          ...VALID_BODY,
          averagePurchasePrice,
        });
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it('accepts an average purchase price with up to six decimal places', async () => {
      const { errors } = await validateCreate({
        ...VALID_BODY,
        averagePurchasePrice: 152.375566,
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects an average purchase price with more than six decimal places', async () => {
      const { errors } = await validateCreate({
        ...VALID_BODY,
        averagePurchasePrice: 152.3755667,
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
