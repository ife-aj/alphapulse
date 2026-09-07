import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PortfoliosService } from './portfolios.service';
import type { HoldingRow, PortfolioRow } from './portfolio.types';

/** Scripted PostgREST response. */
type Result = { data: unknown; error: unknown };

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PORTFOLIO_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const TOKEN = 'token-1';

const portfolioRow: PortfolioRow = {
  id: PORTFOLIO_ID,
  user_id: USER_ID,
  name: 'Tech Holdings',
  created_at: '2026-09-04T10:00:00.000Z',
  updated_at: '2026-09-04T10:00:00.000Z',
};

const holdingRow: HoldingRow = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  portfolio_id: PORTFOLIO_ID,
  symbol: 'AAPL',
  quantity: 12.5,
  average_purchase_price: 152.3755,
  created_at: '2026-09-04T11:00:00.000Z',
  updated_at: '2026-09-04T11:00:00.000Z',
};

const portfolioDto = {
  id: PORTFOLIO_ID,
  name: 'Tech Holdings',
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
};

const holdingDto = {
  id: holdingRow.id,
  symbol: 'AAPL',
  // Numeric cells are echoed as exact canonical decimal strings.
  quantity: '12.5',
  averagePurchasePrice: '152.3755',
  createdAt: '2026-09-04T11:00:00.000Z',
  updatedAt: '2026-09-04T11:00:00.000Z',
};

/**
 * A fluent mock of a PostgREST query builder, copied verbatim from the watchlist
 * spec style: every chained method records its call; terminal `.single()` /
 * `.maybeSingle()` (and `await` via `then`) resolve the scripted result.
 */
function buildChain(result: () => Result, calls: { method: string; args: unknown[] }[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'order', 'eq']) {
    chain[method] = jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  chain.single = jest.fn(() => {
    calls.push({ method: 'single', args: [] });
    return Promise.resolve(result());
  });
  chain.maybeSingle = jest.fn(() => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(result());
  });
  chain.then = (resolve: (v: Result) => void) => {
    calls.push({ method: 'then', args: [] });
    resolve(result());
  };
  return chain;
}

interface TestSupabase {
  supabase: SupabaseService;
  createUserClient: jest.Mock;
  from: jest.Mock;
  calls: { method: string; args: unknown[] }[];
}

function buildSupabase(results: Result[]): TestSupabase {
  const calls: { method: string; args: unknown[] }[] = [];
  const from = jest.fn();
  for (const result of results) {
    from.mockReturnValueOnce(buildChain(() => result, calls));
  }
  const createUserClient = jest.fn().mockReturnValue({ from });
  const supabase = { createUserClient } as unknown as SupabaseService;
  return { supabase, createUserClient, from, calls };
}

describe('PortfoliosService', () => {
  describe('create', () => {
    it('inserts with the authenticated user id and returns the mapped DTO', async () => {
      const { supabase, createUserClient, calls } = buildSupabase([
        { data: portfolioRow, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.create(USER_ID, TOKEN, 'Tech Holdings'),
      ).resolves.toEqual(portfolioDto);

      expect(createUserClient).toHaveBeenCalledWith(TOKEN);
      const insert = calls.find((c) => c.method === 'insert');
      expect(insert?.args[0]).toEqual({ user_id: USER_ID, name: 'Tech Holdings' });
      expect(calls.some((c) => c.method === 'single')).toBe(true);
    });

    it('maps a unique violation to a duplicate-name 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('treats a successful insert with no returned row as an unexpected failure', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('list', () => {
    it('returns the mapped portfolio list without fetching holdings', async () => {
      const second: PortfolioRow = {
        ...portfolioRow,
        id: 'dddddddd-dddd-4ddd-9ddd-dddddddddddd',
        name: 'Dividends',
      };
      const { supabase, from, calls } = buildSupabase([
        { data: [second, portfolioRow], error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(service.list(USER_ID, TOKEN)).resolves.toEqual({
        portfolios: [
          {
            id: second.id,
            name: 'Dividends',
            createdAt: '2026-09-04T10:00:00.000Z',
            updatedAt: '2026-09-04T10:00:00.000Z',
          },
          portfolioDto,
        ],
      });

      expect(from).toHaveBeenCalledTimes(1);
      const eq = calls.find(
        (c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID,
      );
      expect(eq).toBeDefined();
    });

    it('returns { portfolios: [] } when the user has none', async () => {
      const { supabase } = buildSupabase([{ data: [], error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(service.list(USER_ID, TOKEN)).resolves.toEqual({
        portfolios: [],
      });
    });
  });

  describe('getOne', () => {
    it('returns the portfolio with its holdings, decimal cells as strings', async () => {
      const other: HoldingRow = {
        ...holdingRow,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        symbol: 'MSFT',
        quantity: 3,
        average_purchase_price: 400.25,
      };
      const { supabase, calls } = buildSupabase([
        { data: portfolioRow, error: null },
        { data: [holdingRow, other], error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(service.getOne(USER_ID, TOKEN, PORTFOLIO_ID)).resolves.toEqual(
        {
          ...portfolioDto,
          holdings: [
            holdingDto,
            {
              id: other.id,
              symbol: 'MSFT',
              quantity: '3',
              averagePurchasePrice: '400.25',
              createdAt: '2026-09-04T11:00:00.000Z',
              updatedAt: '2026-09-04T11:00:00.000Z',
            },
          ],
        },
      );

      expect(
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' && c.args[0] === 'portfolio_id' && c.args[1] === PORTFOLIO_ID,
        ),
      ).toBe(true);
    });

    it('returns 404 when the portfolio is missing or RLS-hidden', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.getOne(USER_ID, TOKEN, PORTFOLIO_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rename', () => {
    it('updates the user-owned portfolio name and returns the mapped DTO', async () => {
      const renamed = { ...portfolioRow, name: 'Growth Holdings' };
      const { supabase, calls } = buildSupabase([
        { data: renamed, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.rename(USER_ID, TOKEN, PORTFOLIO_ID, 'Growth Holdings'),
      ).resolves.toEqual({ ...portfolioDto, name: 'Growth Holdings' });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ name: 'Growth Holdings' });
      expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
    });

    it('returns 404 on a zero-row update (missing or RLS-hidden)', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.rename(USER_ID, TOKEN, PORTFOLIO_ID, 'X'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a unique violation to a duplicate-name 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.rename(USER_ID, TOKEN, PORTFOLIO_ID, 'Tech'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes the user-owned portfolio and resolves', async () => {
      const { supabase, calls } = buildSupabase([
        { data: portfolioRow, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.remove(USER_ID, TOKEN, PORTFOLIO_ID),
      ).resolves.toBeUndefined();

      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
    });

    it('returns 404 when nothing was deleted (missing or RLS-hidden)', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.remove(USER_ID, TOKEN, PORTFOLIO_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addHolding', () => {
    it('inserts canonical decimal strings and returns the mapped DTO', async () => {
      const { supabase, calls } = buildSupabase([
        { data: holdingRow, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.addHolding(TOKEN, PORTFOLIO_ID, 'AAPL', 12.5, 152.3755),
      ).resolves.toEqual(holdingDto);

      const insert = calls.find((c) => c.method === 'insert');
      expect(insert?.args[0]).toEqual({
        portfolio_id: PORTFOLIO_ID,
        symbol: 'AAPL',
        quantity: '12.5',
        average_purchase_price: '152.3755',
      });
      expect(calls.some((c) => c.method === 'single')).toBe(true);
    });

    it('maps a unique violation to a duplicate-symbol 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.addHolding(TOKEN, PORTFOLIO_ID, 'AAPL', 1, 10),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps an FK violation (missing/inaccessible portfolio) to a 404', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23503', message: 'foreign key violation' } },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.addHolding(TOKEN, PORTFOLIO_ID, 'AAPL', 1, 10),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateHolding', () => {
    it('rejects a patch that changes nothing before any query', async () => {
      const { supabase, createUserClient } = buildSupabase([]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.updateHolding(TOKEN, PORTFOLIO_ID, 'AAPL', undefined, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createUserClient).not.toHaveBeenCalled();
    });

    it('builds a quantity-only patch as a canonical string', async () => {
      const updated = { ...holdingRow, quantity: 15 };
      const { supabase, calls } = buildSupabase([
        { data: updated, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.updateHolding(TOKEN, PORTFOLIO_ID, 'AAPL', 15, undefined),
      ).resolves.toEqual({ ...holdingDto, quantity: '15' });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ quantity: '15' });
    });

    it('builds an average-price-only patch as a canonical string', async () => {
      const updated = { ...holdingRow, average_purchase_price: 160.25 };
      const { supabase, calls } = buildSupabase([
        { data: updated, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.updateHolding(TOKEN, PORTFOLIO_ID, 'AAPL', undefined, 160.25),
      ).resolves.toEqual({ ...holdingDto, averagePurchasePrice: '160.25' });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ average_purchase_price: '160.25' });
    });

    it('returns 404 on a zero-row update (missing or RLS-hidden)', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.updateHolding(TOKEN, PORTFOLIO_ID, 'AAPL', 15, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeHolding', () => {
    it('deletes by portfolio id and symbol, resolving when the row existed', async () => {
      const { supabase, calls } = buildSupabase([
        { data: holdingRow, error: null },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.removeHolding(TOKEN, PORTFOLIO_ID, 'AAPL'),
      ).resolves.toBeUndefined();

      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.method === 'eq' && c.args[0] === 'portfolio_id' && c.args[1] === PORTFOLIO_ID,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'symbol' && c.args[1] === 'AAPL',
        ),
      ).toBe(true);
    });

    it('returns 404 when the holding is missing or RLS-hidden', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.removeHolding(TOKEN, PORTFOLIO_ID, 'AAPL'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps an unexpected PostgREST code to a 503', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: 'XX000', message: 'internal error' } },
      ]);
      const service = new PortfoliosService(supabase);

      await expect(
        service.removeHolding(TOKEN, PORTFOLIO_ID, 'AAPL'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
