import { mapWithConcurrency, VALUATION_QUOTE_CONCURRENCY } from './concurrency';

/** Resolve `value` after a random short delay, to shake out order bugs. */
function delayedResolve<T>(value: T): Promise<T> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(value), Math.floor(Math.random() * 5)),
  );
}

describe('mapWithConcurrency', () => {
  it('returns [] for an empty input without calling the mapper', async () => {
    const mapper = jest.fn();
    await expect(mapWithConcurrency([], 5, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it('maps in input order even when results settle out of order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(
      items,
      2,
      async (n) => delayedResolve(n * 2),
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('never runs more than `limit` mappers at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(items, VALUATION_QUOTE_CONCURRENCY, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await delayedResolve(n);
      active -= 1;
      return n;
    });

    expect(peak).toBeLessThanOrEqual(VALUATION_QUOTE_CONCURRENCY);
  });

  it('rejects when a mapper rejects (all-or-nothing)', async () => {
    const boom = new Error('provider down');
    const mapper = jest
      .fn<Promise<number>, [number, number]>()
      .mockImplementation(async (n) => {
        if (n === 2) throw boom;
        return delayedResolve(n);
      });

    await expect(mapWithConcurrency([1, 2, 3], 2, mapper)).rejects.toBe(boom);
  });

  it('with a limit of 1, stops scheduling new work after a failure', async () => {
    const mapper = jest
      .fn<Promise<number>, [number, number]>()
      .mockImplementation(async () => {
        throw new Error('boom');
      });

    await expect(mapWithConcurrency([1, 2, 3], 1, mapper)).rejects.toThrow(
      'boom',
    );
    // Only the first item was ever attempted before the failure halted the pool.
    expect(mapper).toHaveBeenCalledTimes(1);
  });

  it('runs every item once when all succeed', async () => {
    const mapper = jest.fn(async (n: number) => delayedResolve(n + 1));
    const results = await mapWithConcurrency([1, 2, 3], 2, mapper);
    expect(results).toEqual([2, 3, 4]);
    expect(mapper).toHaveBeenCalledTimes(3);
  });
});
