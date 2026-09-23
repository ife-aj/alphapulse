/**
 * Bounded-concurrency *settle*: at most `limit` mappers in flight at once,
 * input order preserved, and a rejection recorded as a `rejected` result
 * instead of failing the whole batch.
 *
 * Deliberately separate from `portfolios/concurrency.ts`, whose
 * `mapWithConcurrency` fails fast because a REST valuation is all-or-nothing.
 * Callers here have the opposite contract — one dead item must not discard the
 * results that succeeded — so the two must not share an implementation. Workers
 * still drain every item after a failure.
 */

export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled = new Array<PromiseSettledResult<R>>(items.length);
  if (items.length === 0) {
    return settled;
  }

  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        settled[index] = {
          status: 'fulfilled',
          value: await mapper(items[index], index),
        };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return settled;
}
