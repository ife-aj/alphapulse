import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { WatchlistsService } from './watchlists.service';
import type { WatchlistItemRow, WatchlistRow } from './watchlist.types';

/** Scripted PostgREST response. */
type Result = { data: unknown; error: unknown };

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WATCHLIST_ID = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const TOKEN = 'token-1';

const watchlistRow: WatchlistRow = {
  id: WATCHLIST_ID,
  user_id: USER_ID,
  name: 'Tech Stocks',
  created_at: '2026-09-04T10:00:00.000Z',
  updated_at: '2026-09-04T10:00:00.000Z',
};

const itemRow: WatchlistItemRow = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  watchlist_id: WATCHLIST_ID,
  symbol: 'AAPL',
  created_at: '2026-09-04T11:00:00.000Z',
  updated_at: '2026-09-04T11:00:00.000Z',
};

const watchlistDto = {
  id: WATCHLIST_ID,
  name: 'Tech Stocks',
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
};

const itemDto = {
  id: itemRow.id,
  symbol: 'AAPL',
  createdAt: '2026-09-04T11:00:00.000Z',
  updatedAt: '2026-09-04T11:00:00.000Z',
};

/**
 * A fluent mock of a PostgREST query builder. Every chained method records its
 * call and returns the chain; the terminal `.single()` / `.maybeSingle()` and
 * `await` (via `then`) resolve the scripted result and are recorded too, so
 * tests can assert that the service actually invoked them.
 */
function buildChain(result: () => Result, calls: { method: string; args: unknown[] }[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'order', 'eq', 'in']) {
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

/**
 * Build a SupabaseService whose createUserClient returns a client whose
 * `from(table)` yields chains resolving `results` FIFO. `calls` records every
 * chained method invocation for assertion.
 */
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

/** Same as buildSupabase but the terminal calls reject with `error`. */
function buildSupabaseThrowing(error: unknown): TestSupabase {
  const calls: { method: string; args: unknown[] }[] = [];
  const from = jest.fn();
  const chain = buildChain(() => ({ data: null, error: null }), calls);
  chain.single = jest.fn(() => {
    calls.push({ method: 'single', args: [] });
    return Promise.reject(error);
  });
  chain.maybeSingle = jest.fn(() => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.reject(error);
  });
  from.mockReturnValue(chain);
  const createUserClient = jest.fn().mockReturnValue({ from });
  const supabase = { createUserClient } as unknown as SupabaseService;
  return { supabase, createUserClient, from, calls };
}

describe('WatchlistsService', () => {
  describe('create', () => {
    it('inserts with the authenticated user id and returns the mapped DTO', async () => {
      const { supabase, createUserClient, calls } = buildSupabase([
        { data: watchlistRow, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech Stocks')).resolves.toEqual(
        watchlistDto,
      );

      expect(createUserClient).toHaveBeenCalledWith(TOKEN);
      const insert = calls.find((c) => c.method === 'insert');
      expect(insert?.args[0]).toEqual({ user_id: USER_ID, name: 'Tech Stocks' });
      expect(calls.some((c) => c.method === 'single')).toBe(true);
    });

    it('maps a unique violation to a duplicate-name 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps an unexpected PostgREST code to a 503', async () => {
      const { supabase } = buildSupabase([
        {
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          },
        },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('treats a successful insert with no returned row as an unexpected failure', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('maps a thrown network failure to a 503', async () => {
      const { supabase } = buildSupabaseThrowing(new Error('fetch failed'));
      const service = new WatchlistsService(supabase);

      await expect(service.create(USER_ID, TOKEN, 'Tech')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('list', () => {
    it('returns watchlists with their items, grouped and in order', async () => {
      const otherId = 'dddddddd-dddd-4ddd-9ddd-dddddddddddd';
      const secondRow: WatchlistRow = {
        ...watchlistRow,
        id: otherId,
        name: 'Dividends',
        created_at: '2026-09-03T10:00:00.000Z',
      };
      const otherItem: WatchlistItemRow = {
        ...itemRow,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        watchlist_id: otherId,
        symbol: 'MSFT',
      };
      const { supabase, calls } = buildSupabase([
        { data: [watchlistRow, secondRow], error: null },
        { data: [itemRow, otherItem], error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.list(USER_ID, TOKEN)).resolves.toEqual({
        watchlists: [
          { ...watchlistDto, items: [itemDto] },
          {
            id: otherId,
            name: 'Dividends',
            createdAt: '2026-09-03T10:00:00.000Z',
            updatedAt: '2026-09-04T10:00:00.000Z',
            items: [
              {
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                symbol: 'MSFT',
                createdAt: '2026-09-04T11:00:00.000Z',
                updatedAt: '2026-09-04T11:00:00.000Z',
              },
            ],
          },
        ],
      });

      const inCall = calls.find((c) => c.method === 'in');
      expect(inCall?.args).toEqual(['watchlist_id', [WATCHLIST_ID, otherId]]);
    });

    it('returns { watchlists: [] } and does not query items when the user has none', async () => {
      const { supabase, from, calls } = buildSupabase([
        { data: [], error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.list(USER_ID, TOKEN)).resolves.toEqual({
        watchlists: [],
      });

      expect(from).toHaveBeenCalledTimes(1);
      expect(calls.some((c) => c.method === 'in')).toBe(false);
    });

    it('maps an unexpected database error to a 503', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: 'XX000', message: 'internal error' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.list(USER_ID, TOKEN)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('rename', () => {
    it('updates the user-owned watchlist and returns the mapped DTO', async () => {
      const renamed = { ...watchlistRow, name: 'Growth Stocks' };
      const { supabase, calls } = buildSupabase([
        { data: renamed, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(
        service.rename(USER_ID, TOKEN, WATCHLIST_ID, 'Growth Stocks'),
      ).resolves.toEqual({ ...watchlistDto, name: 'Growth Stocks' });

      const update = calls.find((c) => c.method === 'update');
      expect(update?.args[0]).toEqual({ name: 'Growth Stocks' });
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === WATCHLIST_ID)).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true);
      expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
    });

    it('returns 404 when the watchlist is not found or RLS-hidden (zero rows)', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new WatchlistsService(supabase);

      await expect(service.rename(USER_ID, TOKEN, WATCHLIST_ID, 'X')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('maps a unique violation to a duplicate-name 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(
        service.rename(USER_ID, TOKEN, WATCHLIST_ID, 'Tech'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes the user-owned watchlist and resolves', async () => {
      const { supabase, calls } = buildSupabase([
        { data: watchlistRow, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.remove(USER_ID, TOKEN, WATCHLIST_ID)).resolves.toBeUndefined();

      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === WATCHLIST_ID)).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true);
      expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
    });

    it('returns 404 when nothing was deleted (missing or RLS-hidden)', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new WatchlistsService(supabase);

      await expect(service.remove(USER_ID, TOKEN, WATCHLIST_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('addItem', () => {
    it('inserts the normalized symbol and returns the mapped DTO', async () => {
      const { supabase, calls } = buildSupabase([
        { data: itemRow, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.addItem(TOKEN, WATCHLIST_ID, 'AAPL')).resolves.toEqual(
        itemDto,
      );

      const insert = calls.find((c) => c.method === 'insert');
      expect(insert?.args[0]).toEqual({ watchlist_id: WATCHLIST_ID, symbol: 'AAPL' });
      expect(calls.some((c) => c.method === 'single')).toBe(true);
    });

    it('maps a unique violation to a duplicate-symbol 409', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.addItem(TOKEN, WATCHLIST_ID, 'AAPL')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps an FK violation (missing/inaccessible watchlist) to a 404', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '23503', message: 'foreign key violation' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.addItem(TOKEN, WATCHLIST_ID, 'AAPL')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('maps an RLS policy rejection to a 404', async () => {
      const { supabase } = buildSupabase([
        { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.addItem(TOKEN, WATCHLIST_ID, 'AAPL')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('removeItem', () => {
    it('deletes by watchlist id and symbol, resolving when the row existed', async () => {
      const { supabase, calls } = buildSupabase([
        { data: itemRow, error: null },
      ]);
      const service = new WatchlistsService(supabase);

      await expect(service.removeItem(TOKEN, WATCHLIST_ID, 'AAPL')).resolves.toBeUndefined();

      expect(calls.some((c) => c.method === 'delete')).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'watchlist_id' && c.args[1] === WATCHLIST_ID)).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'symbol' && c.args[1] === 'AAPL')).toBe(true);
      expect(calls.some((c) => c.method === 'maybeSingle')).toBe(true);
    });

    it('returns 404 when the item is missing or RLS-hidden', async () => {
      const { supabase } = buildSupabase([{ data: null, error: null }]);
      const service = new WatchlistsService(supabase);

      await expect(service.removeItem(TOKEN, WATCHLIST_ID, 'AAPL')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
