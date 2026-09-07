import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateHoldingDto } from './update-holding.dto';

/**
 * Mirror how the global ValidationPipe processes a body DTO. Note that the DTO
 * layer alone cannot reject an *empty* object — both fields are optional and
 * skip only `undefined` — so that rule lives in the service. The DTO tests here
 * pin the boundary: `null` and every invalid value reject, a genuinely absent
 * field is fine.
 */
async function validateUpdate(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateHoldingDto, body);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('UpdateHoldingDto', () => {
  it('accepts quantity only', async () => {
    const { errors } = await validateUpdate({ quantity: 15 });
    expect(errors).toHaveLength(0);
  });

  it('accepts averagePurchasePrice only', async () => {
    const { errors } = await validateUpdate({ averagePurchasePrice: 160.25 });
    expect(errors).toHaveLength(0);
  });

  it('accepts both fields', async () => {
    const { errors } = await validateUpdate({
      quantity: 15,
      averagePurchasePrice: 160.25,
    });
    expect(errors).toHaveLength(0);
  });

  it('passes an empty body at the DTO layer (the service rejects it)', async () => {
    const { errors } = await validateUpdate({});
    expect(errors).toHaveLength(0);
  });

  it.each(['quantity', 'averagePurchasePrice'])(
    'does NOT treat null as absent — %s: null rejects',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: null });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['quantity', 'averagePurchasePrice'])(
    'rejects a zero %s',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: 0 });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['quantity', 'averagePurchasePrice'])(
    'rejects a negative %s',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: -1 });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['quantity', 'averagePurchasePrice'])(
    'rejects a non-finite %s',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: NaN });
      expect(errors.length).toBeGreaterThan(0);
      const { errors: inf } = await validateUpdate({ [field]: Infinity });
      expect(inf.length).toBeGreaterThan(0);
    },
  );

  it.each(['quantity', 'averagePurchasePrice'])(
    'rejects a %s with more than six decimal places',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: 1.1234567 });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['quantity', 'averagePurchasePrice'])(
    'rejects a non-number %s',
    async (field) => {
      const { errors } = await validateUpdate({ [field]: '15' });
      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
