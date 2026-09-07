/**
 * Bounded-concurrency primitive used to fetch live quotes during a valuation.
 *
 * Valuation can touch many holdings at once. Running one Finnhub request per
 * holding with `Promise.all` would fire unboundedly, so quotes are fetched
 * through a small worker pool that keeps at most `limit` mappers in flight while
 * preserving input order. A rejection fails the whole call (all-or-nothing,
 * matching the API's valuation contract); the remaining in-flight mappers are
 * allowed to settle so no promise is left unhandled, but no new work is
 * scheduled after a failure.
 */

/** How many quote requests a single valuation may have in flight at once. */
export const VALUATION_QUOTE_CONCURRENCY = 5;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }

  const workerCount = Math.min(limit, items.length);
  let nextIndex = 0;
  let completed = 0;
  let failed = false;

  await new Promise<void>((resolve, reject) => {
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        try {
          results[index] = await mapper(items[index], index);
        } catch (error) {
          failed = true;
          reject(error);
          return;
        }
        completed += 1;
        if (completed === items.length) {
          resolve();
        }
      }
    };

    for (let i = 0; i < workerCount; i += 1) {
      void worker();
    }
  });

  return results;
}
