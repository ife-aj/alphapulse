import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PortfolioValuationDto } from '../portfolios/dto/valuation-response.dto';
import type { PortfolioGateway } from './portfolio.gateway';
import {
  DEFAULT_REALTIME_REFRESH_INTERVAL_MS,
  RealtimeRecalculationScheduler,
} from './realtime-recalculation-scheduler.service';
import type { RealtimeRecalculationService } from './realtime-recalculation.service';
import type { RealtimeSubscriptionService } from './realtime-subscription.service';
import type {
  ActivePortfolioIdentity,
  PortfolioRecalculationFailure,
  PortfolioRecalculationResult,
  RealtimeRecalculationResult,
} from './realtime.types';
import {
  INTERNAL_ERROR_MESSAGE,
  MARKET_UNAVAILABLE_MESSAGE,
  PORTFOLIO_ERROR_EVENT,
  PORTFOLIO_NOT_FOUND_MESSAGE,
  PORTFOLIO_VALUATION_EVENT,
  portfolioRoom,
} from './realtime.types';

/**
 * Scheduler unit tests over the real `RealtimeRecalculationScheduler`, with
 * scripted registry, recalculation, and gateway collaborators.
 *
 * Every test drives time with Jest's fake timers — no real sleeps — and the
 * collaborators are deferred promises, so a cycle can be held open exactly as
 * long as a test needs it to be.
 */

const USER_ID = 'user-1';
const USER_B = 'user-2';
const PORTFOLIO_1 = '11111111-1111-4111-8111-111111111111';
const PORTFOLIO_2 = '22222222-2222-4222-8222-222222222222';
const INTERVAL = 5000;

/** A deferred we can resolve/reject on demand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-resolved promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function identity(
  userId: string,
  portfolioId: string,
  revision = 1,
): ActivePortfolioIdentity {
  return { userId, portfolioId, revision };
}

function valuationFor(portfolioId: string): PortfolioValuationDto {
  return {
    portfolioId,
    totalInvestedValue: '1000.00',
    totalCurrentValue: '1500.00',
    totalProfitLoss: '500.00',
    totalReturnPercentage: '50.00',
    holdings: [],
  };
}

function success(entry: ActivePortfolioIdentity): PortfolioRecalculationResult {
  return {
    ok: true,
    userId: entry.userId,
    portfolioId: entry.portfolioId,
    revision: entry.revision,
    valuation: valuationFor(entry.portfolioId),
  };
}

function failure(
  entry: ActivePortfolioIdentity,
  code: PortfolioRecalculationFailure['code'] = 'MISSING_PRICE',
  unpricedSymbols: string[] = [],
): PortfolioRecalculationResult {
  return {
    ok: false,
    userId: entry.userId,
    portfolioId: entry.portfolioId,
    revision: entry.revision,
    code,
    unpricedSymbols,
  };
}

function resultFor(
  results: PortfolioRecalculationResult[],
): RealtimeRecalculationResult {
  return { prices: new Map(), failedSymbols: [], results };
}

/**
 * A registry stub that models activations for real: subscribing to a portfolio
 * that is already active joins the *same* activation (no new revision), and an
 * unsubscribe followed by a subscribe creates a new one — exactly as
 * `RealtimeSubscriptionService` behaves.
 */
function makeRegistry() {
  const active = new Map<string, ActivePortfolioIdentity>();
  let nextRevision = 0;

  return {
    activate(userId: string, portfolioId: string): ActivePortfolioIdentity {
      const key = `${userId}:${portfolioId}`;
      const existing = active.get(key);
      if (existing !== undefined) {
        return existing;
      }
      nextRevision += 1;
      const entry = identity(userId, portfolioId, nextRevision);
      active.set(key, entry);
      return entry;
    },
    deactivate(userId: string, portfolioId: string): void {
      active.delete(`${userId}:${portfolioId}`);
    },
    getActivePortfolioIdentities: jest.fn((): ActivePortfolioIdentity[] => [
      ...active.values(),
    ]),
    isActivePortfolio: jest.fn(
      (userId: string, portfolioId: string, revision: number): boolean =>
        active.get(`${userId}:${portfolioId}`)?.revision === revision,
    ),
  };
}

type RegistryStub = ReturnType<typeof makeRegistry>;

function makeRecalculation() {
  return { recalculate: jest.fn() };
}

type RecalculationStub = ReturnType<typeof makeRecalculation>;

function makeGateway() {
  return { broadcastValuation: jest.fn(), broadcastPortfolioError: jest.fn() };
}

type GatewayStub = ReturnType<typeof makeGateway>;

/**
 * A config stub. A key that is absent from `values` reads back as `undefined`,
 * which is what an unset environment variable looks like.
 */
function makeConfig(values: Record<string, unknown> = {}): { get: jest.Mock } {
  return { get: jest.fn((key: string) => values[key]) };
}

const CONFIGURED = { REALTIME_REFRESH_INTERVAL_MS: String(INTERVAL) };

function makeScheduler(
  registry: RegistryStub = makeRegistry(),
  recalculation: RecalculationStub = makeRecalculation(),
  gateway: GatewayStub = makeGateway(),
  config: { get: jest.Mock } = makeConfig(CONFIGURED),
) {
  return {
    registry,
    recalculation,
    gateway,
    config,
    scheduler: new RealtimeRecalculationScheduler(
      config as unknown as ConfigService,
      registry as unknown as RealtimeSubscriptionService,
      recalculation as unknown as RealtimeRecalculationService,
      gateway as unknown as PortfolioGateway,
    ),
  };
}

/** Start the scheduler and let its first tick come due. */
async function startAndTick(
  scheduler: RealtimeRecalculationScheduler,
  interval = INTERVAL,
): Promise<void> {
  scheduler.onModuleInit();
  jest.advanceTimersByTime(interval);
  await flush();
}

/** Silence the scheduler's logger for tests that provoke failures. */
function silenceLogger(): jest.SpyInstance[] {
  return (['log', 'warn', 'error', 'debug'] as const).map((method) =>
    jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
  );
}

describe('RealtimeRecalculationScheduler', () => {
  beforeEach(() => {
    // `setImmediate` stays real: the scheduler's timer is what these tests
    // control, and `flush()` needs a genuine event-loop turn to drain the
    // microtasks a released cycle leaves behind.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('scheduling', () => {
    it('arms its first cycle one interval after start, not immediately', async () => {
      const { registry, recalculation, scheduler } = makeScheduler();
      registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([]));

      scheduler.onModuleInit();
      await flush();

      // Nothing has run yet: the first tick is a full interval away.
      expect(recalculation.recalculate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(INTERVAL - 1);
      await flush();
      expect(recalculation.recalculate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
    });

    it('keeps running at the configured interval', async () => {
      const { registry, recalculation, scheduler } = makeScheduler();
      registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([]));

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(INTERVAL);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(INTERVAL);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(3);
    });

    it('honours a configured interval other than the default', async () => {
      const { registry, recalculation, scheduler } = makeScheduler(
        undefined,
        undefined,
        undefined,
        makeConfig({ REALTIME_REFRESH_INTERVAL_MS: '250' }),
      );
      registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([]));

      scheduler.onModuleInit();
      jest.advanceTimersByTime(250);
      await flush();

      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
    });

    it('falls back to the default when the interval is missing or unusable', async () => {
      // `undefined` means the variable is not set at all; the rest are set but
      // unusable. Each must land on the default rather than arming a timer that
      // fires immediately in a loop.
      for (const configured of [undefined, '', 'not-a-number', '0', '-1']) {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        const config = makeConfig(
          configured === undefined
            ? {}
            : { REALTIME_REFRESH_INTERVAL_MS: configured },
        );
        const { registry, recalculation, scheduler } = makeScheduler(
          undefined,
          undefined,
          undefined,
          config,
        );
        registry.activate(USER_ID, PORTFOLIO_1);
        recalculation.recalculate.mockResolvedValue(resultFor([]));

        scheduler.onModuleInit();
        jest.advanceTimersByTime(DEFAULT_REALTIME_REFRESH_INTERVAL_MS - 1);
        await flush();
        expect(recalculation.recalculate).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flush();
        expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

        scheduler.onModuleDestroy();
        jest.useRealTimers();
      }
    });
  });

  describe('idle guard', () => {
    it('does not recalculate when no portfolio is active', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      recalculation.recalculate.mockResolvedValue(resultFor([]));

      await startAndTick(scheduler);

      expect(recalculation.recalculate).not.toHaveBeenCalled();
      expect(gateway.broadcastValuation).not.toHaveBeenCalled();

      // And it keeps not doing so, cycle after cycle.
      jest.advanceTimersByTime(INTERVAL * 3);
      await flush();
      expect(recalculation.recalculate).not.toHaveBeenCalled();
    });

    it('starts recalculating once a portfolio becomes active', async () => {
      const { registry, recalculation, scheduler } = makeScheduler();
      recalculation.recalculate.mockResolvedValue(resultFor([]));

      await startAndTick(scheduler);
      expect(recalculation.recalculate).not.toHaveBeenCalled();

      registry.activate(USER_ID, PORTFOLIO_1);
      jest.advanceTimersByTime(INTERVAL);
      await flush();

      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
    });
  });

  describe('broadcasting', () => {
    it('broadcasts a successful valuation to the portfolio room', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([success(entry)]));

      await startAndTick(scheduler);

      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
      const [userId, portfolioId, event] = gateway.broadcastValuation.mock
        .calls[0] as [
        string,
        string,
        { portfolioId: string; emittedAt: string },
      ];
      expect(userId).toBe(USER_ID);
      expect(portfolioId).toBe(PORTFOLIO_1);
      expect(event.portfolioId).toBe(PORTFOLIO_1);
      // The payload is the REST valuation, unchanged, plus a server timestamp.
      expect(event).toMatchObject({
        valuation: valuationFor(PORTFOLIO_1),
      });
      expect(new Date(event.emittedAt).toISOString()).toBe(event.emittedAt);
      expect(gateway.broadcastPortfolioError).not.toHaveBeenCalled();
    });

    it('emits one broadcast for a portfolio with several sockets', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      // Two sockets are one active portfolio, so the registry reports one
      // identity and the cycle produces one result.
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([success(entry)]));

      await startAndTick(scheduler);

      // One call per portfolio — Socket.IO fans it out to the room's sockets.
      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastValuation).toHaveBeenCalledWith(
        USER_ID,
        PORTFOLIO_1,
        expect.objectContaining({ portfolioId: PORTFOLIO_1 }),
      );
    });

    it('broadcasts each portfolio independently', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const first = registry.activate(USER_ID, PORTFOLIO_1);
      const second = registry.activate(USER_B, PORTFOLIO_2);
      recalculation.recalculate.mockResolvedValue(
        resultFor([success(first), success(second)]),
      );

      await startAndTick(scheduler);

      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(2);
      expect(
        gateway.broadcastValuation.mock.calls.map((call: unknown[]) => call[1]),
      ).toEqual([PORTFOLIO_1, PORTFOLIO_2]);
    });

    it('emits a sanitized portfolio:error for a failed portfolio', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(
        resultFor([failure(entry, 'MISSING_PRICE', ['TSLA'])]),
      );
      const logSpies = silenceLogger();

      try {
        await startAndTick(scheduler);

        expect(gateway.broadcastValuation).not.toHaveBeenCalled();
        expect(gateway.broadcastPortfolioError).toHaveBeenCalledWith(
          USER_ID,
          PORTFOLIO_1,
          { code: 'MARKET_UNAVAILABLE', message: MARKET_UNAVAILABLE_MESSAGE },
        );

        // Nothing about the cause reaches the client: no symbol, no code from
        // the internal vocabulary.
        const payload = JSON.stringify(
          gateway.broadcastPortfolioError.mock.calls[0],
        );
        expect(payload).not.toContain('TSLA');
        expect(payload).not.toContain('MISSING_PRICE');
        expect(payload).not.toContain('MISSING');
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });

    it.each([
      [
        'PORTFOLIO_NOT_FOUND',
        'PORTFOLIO_NOT_FOUND',
        PORTFOLIO_NOT_FOUND_MESSAGE,
      ],
      [
        'HOLDINGS_UNAVAILABLE',
        'MARKET_UNAVAILABLE',
        MARKET_UNAVAILABLE_MESSAGE,
      ],
      ['MISSING_PRICE', 'MARKET_UNAVAILABLE', MARKET_UNAVAILABLE_MESSAGE],
      ['INTERNAL_ERROR', 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE],
    ] as const)(
      'maps the %s failure onto the socket contract',
      async (code, expectedCode, expectedMessage) => {
        const { registry, recalculation, gateway, scheduler } = makeScheduler();
        const entry = registry.activate(USER_ID, PORTFOLIO_1);
        recalculation.recalculate.mockResolvedValue(
          resultFor([failure(entry, code)]),
        );
        const logSpies = silenceLogger();

        try {
          await startAndTick(scheduler);

          expect(gateway.broadcastPortfolioError).toHaveBeenCalledWith(
            USER_ID,
            PORTFOLIO_1,
            { code: expectedCode, message: expectedMessage },
          );
        } finally {
          logSpies.forEach((spy) => spy.mockRestore());
        }
      },
    );

    it('broadcasts the successes even when another portfolio fails', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const healthy = registry.activate(USER_ID, PORTFOLIO_1);
      const broken = registry.activate(USER_B, PORTFOLIO_2);
      recalculation.recalculate.mockResolvedValue(
        resultFor([success(healthy), failure(broken, 'PORTFOLIO_NOT_FOUND')]),
      );
      const logSpies = silenceLogger();

      try {
        await startAndTick(scheduler);

        expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
        expect(gateway.broadcastValuation.mock.calls[0][1]).toBe(PORTFOLIO_1);
        expect(gateway.broadcastPortfolioError).toHaveBeenCalledTimes(1);
        expect(gateway.broadcastPortfolioError.mock.calls[0][1]).toBe(
          PORTFOLIO_2,
        );
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  describe('stale-result protection', () => {
    it('publishes nothing for a portfolio unsubscribed during the cycle', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValue(gate.promise);

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      // The subscriber leaves while the cycle is still running.
      registry.deactivate(USER_ID, PORTFOLIO_1);
      gate.resolve(resultFor([success(entry)]));
      await flush();

      expect(gateway.broadcastValuation).not.toHaveBeenCalled();
      expect(gateway.broadcastPortfolioError).not.toHaveBeenCalled();
    });

    it('does not deliver a stale result to an unsubscribe-then-resubscribe', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const original = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValue(gate.promise);

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      // Same socket, same portfolio — but a new subscription. Identity alone
      // would say "still active"; the revision is what says otherwise.
      registry.deactivate(USER_ID, PORTFOLIO_1);
      const resubscribed = registry.activate(USER_ID, PORTFOLIO_1);
      expect(resubscribed.revision).not.toBe(original.revision);

      gate.resolve(resultFor([success(original)]));
      await flush();

      expect(gateway.broadcastValuation).not.toHaveBeenCalled();
    });

    it('still delivers to a portfolio whose other socket kept it active', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValue(gate.promise);

      await startAndTick(scheduler);

      // A second socket joining does not end the activation, so the cycle's
      // result still belongs to the sockets now watching.
      registry.activate(USER_ID, PORTFOLIO_1);

      gate.resolve(resultFor([success(entry)]));
      await flush();

      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
    });

    it('suppresses the stale result but keeps publishing later cycles', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const original = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValueOnce(gate.promise);

      await startAndTick(scheduler);
      registry.deactivate(USER_ID, PORTFOLIO_1);
      const resubscribed = registry.activate(USER_ID, PORTFOLIO_1);
      gate.resolve(resultFor([success(original)]));
      await flush();
      expect(gateway.broadcastValuation).not.toHaveBeenCalled();

      // The next cycle computes for the *current* activation and is delivered.
      recalculation.recalculate.mockResolvedValue(
        resultFor([success(resubscribed)]),
      );
      jest.advanceTimersByTime(INTERVAL);
      await flush();

      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastValuation.mock.calls[0][1]).toBe(PORTFOLIO_1);
    });
  });

  describe('overlap and resilience', () => {
    it('never overlaps cycles, however slow one is', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValue(gate.promise);

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      // Several intervals pass while the first cycle is still in flight. A
      // setInterval would have fired three more times by now.
      jest.advanceTimersByTime(INTERVAL * 3);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      gate.resolve(resultFor([success(entry)]));
      await flush();

      // Released, it publishes once and arms exactly one follow-up cycle.
      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(INTERVAL);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(2);
    });

    it('keeps scheduling after a cycle throws', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate
        .mockRejectedValueOnce(new ServiceUnavailableException('boom'))
        .mockResolvedValue(resultFor([success(entry)]));
      const logSpies = silenceLogger();

      try {
        await startAndTick(scheduler);
        expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
        expect(gateway.broadcastValuation).not.toHaveBeenCalled();

        // The poller survived: the next interval runs another cycle, and it
        // publishes normally.
        jest.advanceTimersByTime(INTERVAL);
        await flush();

        expect(recalculation.recalculate).toHaveBeenCalledTimes(2);
        expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });

    it('logs a cycle failure without the exception message', async () => {
      const { registry, recalculation, scheduler } = makeScheduler();
      registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockRejectedValue(
        new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal'),
      );
      const logSpies = silenceLogger();

      try {
        await startAndTick(scheduler);

        const logged = logSpies
          .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
          .join('\n');
        expect(logged).toContain('Recalculation cycle failed');
        expect(logged).not.toContain('hunter2');
        expect(logged).not.toContain('db.internal');
        expect(logged).not.toContain('ECONNREFUSED');
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  describe('shutdown', () => {
    it('stops after module destruction and cancels the pending timer', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      recalculation.recalculate.mockResolvedValue(resultFor([success(entry)]));

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);

      scheduler.onModuleDestroy();

      // No pending work is left behind, and no further cycle is armed.
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(INTERVAL * 5);
      await flush();

      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
      expect(gateway.broadcastValuation).toHaveBeenCalledTimes(1);
    });

    it('does not arm a new cycle when a running cycle finishes after shutdown', async () => {
      const { registry, recalculation, gateway, scheduler } = makeScheduler();
      const entry = registry.activate(USER_ID, PORTFOLIO_1);
      const gate = deferred<RealtimeRecalculationResult>();
      recalculation.recalculate.mockReturnValue(gate.promise);

      await startAndTick(scheduler);
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);

      // Shutdown: sockets disconnect (their activations go with them) and the
      // module is destroyed while the cycle is still in flight.
      registry.deactivate(USER_ID, PORTFOLIO_1);
      scheduler.onModuleDestroy();

      gate.resolve(resultFor([success(entry)]));
      await flush();

      // The settling cycle publishes nothing — its subscription is gone — and
      // arms nothing.
      expect(gateway.broadcastValuation).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(INTERVAL * 5);
      await flush();
      expect(recalculation.recalculate).toHaveBeenCalledTimes(1);
    });

    it('is safe to destroy without ever having started', () => {
      const { scheduler } = makeScheduler();

      expect(() => scheduler.onModuleDestroy()).not.toThrow();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('room convention', () => {
    it('addresses the same room the gateway subscribes sockets to', () => {
      // The broadcast room is derived from the authenticated identity by the
      // gateway, using one shared helper — asserted here so a scheduled emit
      // and a subscribe-time emit can never address different rooms.
      expect(portfolioRoom(USER_ID, PORTFOLIO_1)).toBe(
        `portfolio:${USER_ID}:${PORTFOLIO_1}`,
      );
      expect(PORTFOLIO_VALUATION_EVENT).toBe('portfolio:valuation');
      expect(PORTFOLIO_ERROR_EVENT).toBe('portfolio:error');
    });
  });
});
