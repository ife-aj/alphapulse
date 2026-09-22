import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import type { PortfolioValuationDto } from '../portfolios/dto/valuation-response.dto';
import type { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import type { ValuationHolding } from '../portfolios/valuation-computation';
import {
  RealtimeSubscriptionService,
  type SubscriptionAttemptId,
} from './realtime-subscription.service';

/**
 * Registry lifecycle unit tests, over the real `RealtimeSubscriptionService`
 * with a scripted `PortfoliosValuationService` stub. Deterministic deferred
 * promises (never arbitrary sleeps) drive every race.
 */

const SOCKET_A = 'socket-a';
const SOCKET_B = 'socket-b';
const SOCKET_C = 'socket-c';
const SOCKET_D = 'socket-d';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const TOKEN = 'token-1';
const PORTFOLIO_1 = '11111111-1111-4111-8111-111111111111';
const PORTFOLIO_2 = '22222222-2222-4222-8222-222222222222';

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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function holding(symbol: string): ValuationHolding {
  return {
    symbol,
    quantity: new Decimal('1'),
    averagePurchasePrice: new Decimal('10'),
  };
}

function holdings(...symbols: string[]): ValuationHolding[] {
  return symbols.map(holding);
}

function valuationFor(portfolioId: string): PortfolioValuationDto {
  return {
    portfolioId,
    totalInvestedValue: '10.00',
    totalCurrentValue: '20.00',
    totalProfitLoss: '10.00',
    totalReturnPercentage: '100.00',
    holdings: [],
  };
}

function sort(items: string[]): string[] {
  return [...items].sort();
}

/** Fabricate an opaque attempt id where a test needs one from thin air. */
function attemptId(n: number): SubscriptionAttemptId {
  return n as SubscriptionAttemptId;
}

/** A scripted valuation service stub (`getValuationHoldings` + `valueHoldings`). */
function makeValuationService() {
  return {
    getValuationHoldings: jest.fn(),
    valueHoldings: jest.fn(),
  };
}

type ValuationStub = ReturnType<typeof makeValuationService>;

function makeService(valuation: ValuationStub = makeValuationService()) {
  return {
    valuation,
    service: new RealtimeSubscriptionService(
      valuation as unknown as PortfoliosValuationService,
    ),
  };
}

function subscribe(
  service: RealtimeSubscriptionService,
  socketId: string,
  userId: string,
  portfolioId: string,
) {
  return service.subscribe({
    socketId,
    userId,
    accessToken: TOKEN,
    portfolioId,
  });
}

/** A stub that resolves every holdings read to the same symbol list. */
function stubHoldings(valuation: ValuationStub, symbols: string[]): void {
  valuation.getValuationHoldings.mockResolvedValue(holdings(...symbols));
  valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));
}

describe('RealtimeSubscriptionService', () => {
  describe('portfolio identity keys', () => {
    it('maps equal userId/portfolioId values onto the same registry entry, however they were constructed', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL', 'MSFT']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      // A separately supplied, value-equal user id ("user-" + "1") and the same
      // portfolio UUID address the very same portfolio entry — not a new one.
      const sameUser = ['user', '1'].join('-');
      expect(sameUser).toBe(USER_ID);
      await subscribe(service, SOCKET_B, sameUser, `${PORTFOLIO_1}`);

      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
        SOCKET_B,
      ]);
      expect(service.getPortfolioSocketIds(sameUser, PORTFOLIO_1)).toEqual([
        SOCKET_A,
        SOCKET_B,
      ]);
      // Both sockets are one active portfolio, so AAPL is referenced once.
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
    });

    it('never collides: user ids and portfolio ids cannot bleed into each other', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      // Arbitrary user-id contents (the registry only sees authenticated ids,
      // but the key must stay unambiguous regardless) must not alias.
      await subscribe(service, SOCKET_A, 'a', PORTFOLIO_1);
      await subscribe(service, SOCKET_B, 'a:b', PORTFOLIO_1);

      expect(service.getPortfolioSocketIds('a', PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(service.getPortfolioSocketIds('a:b', PORTFOLIO_1)).toEqual([
        SOCKET_B,
      ]);
    });
  });

  describe('registered socket identity', () => {
    it('rejects a subscription whose user id disagrees with the socket identity', async () => {
      const { valuation, service } = makeService();
      // Holdings are scripted per portfolio so a stray lookup or symbol-index
      // write for user B's request would be visible in the assertions below.
      valuation.getValuationHoldings.mockImplementation(
        (_userId: string, _token: string, portfolioId: string) =>
          Promise.resolve(
            portfolioId === PORTFOLIO_1 ? holdings('AAPL') : holdings('MSFT'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      // (1) The socket registers and subscribes as user A.
      const first = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(first.kind).toBe('subscribed');
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);

      // (2) The same socket then presents a different authenticated identity.
      const rejection: unknown = await subscribe(
        service,
        SOCKET_A,
        OTHER_USER_ID,
        PORTFOLIO_2,
      ).then(
        () => null,
        (error: unknown) => error,
      );

      // (3) Rejected as an internal identity-consistency failure, with a message
      // that exposes neither user id.
      expect(rejection).toBeInstanceOf(ConflictException);
      expect((rejection as ConflictException).message).not.toContain(USER_ID);
      expect((rejection as ConflictException).message).not.toContain(
        OTHER_USER_ID,
      );

      // (6) Neither holdings loading nor valuation ran for the mismatched call.
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.getValuationHoldings).not.toHaveBeenCalledWith(
        OTHER_USER_ID,
        TOKEN,
        PORTFOLIO_2,
      );
      expect(valuation.valueHoldings).not.toHaveBeenCalledWith(
        PORTFOLIO_2,
        expect.anything(),
      );

      // (4) (5) No pending or active subscription, and no portfolio or symbol
      // index state, exists for user B.
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.getPortfolioSocketIds(OTHER_USER_ID, PORTFOLIO_2)).toEqual(
        [],
      );
      expect(service.getPortfolioSymbols(OTHER_USER_ID, PORTFOLIO_2)).toEqual(
        [],
      );
      expect(service.symbolReferenceCount('MSFT')).toBe(0);

      // (7) User A's existing registry state is untouched.
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([
        'AAPL',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      // (8) A later, correctly identified operation on the same socket works.
      const later = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_2);
      expect(later.kind).toBe('subscribed');
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
        { userId: USER_ID, portfolioId: PORTFOLIO_2, state: 'ACTIVE' },
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
    });

    it('keeps sockets registered to different users fully independent', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockImplementation(
        (userId: string, _token: string, _portfolioId: string) =>
          Promise.resolve(
            userId === USER_ID ? holdings('AAPL') : holdings('MSFT'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      // The same portfolio UUID, under a different authenticated user, is a
      // wholly separate registry entry.
      await subscribe(service, SOCKET_B, OTHER_USER_ID, PORTFOLIO_1);

      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.getSocketSubscriptions(SOCKET_B)).toEqual([
        { userId: OTHER_USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(service.getPortfolioSocketIds(OTHER_USER_ID, PORTFOLIO_1)).toEqual(
        [SOCKET_B],
      );
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([
        'AAPL',
      ]);
      expect(service.getPortfolioSymbols(OTHER_USER_ID, PORTFOLIO_1)).toEqual([
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);

      // Each socket keeps its own identity: A's repeat is still a duplicate and
      // B's cross-identity attempt is still rejected, leaving B untouched.
      expect(await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1)).toEqual({
        kind: 'duplicate',
      });
      await expect(
        subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(service.getPortfolioSymbols(OTHER_USER_ID, PORTFOLIO_1)).toEqual([
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
    });
  });

  describe('socket identity lifetime', () => {
    it('binds the socket to its user until disconnect, then allows a fresh registration', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockImplementation(
        (userId: string, _token: string, _portfolioId: string) =>
          Promise.resolve(
            userId === USER_ID ? holdings('AAPL') : holdings('MSFT'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      // (1) The socket registers as user A through a valid subscription.
      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);

      // (2) Its final portfolio is unsubscribed. Subscription state is released
      // in full: no socket on the portfolio, no symbol references.
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);

      // (3) (4) (5) The empty socket is still bound to user A, so a later
      // subscription as user B is rejected before authorization, valuation, or
      // any index change — that rejection is the proof the binding survived.
      const rejection: unknown = await subscribe(
        service,
        SOCKET_A,
        OTHER_USER_ID,
        PORTFOLIO_2,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(ConflictException);
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.getValuationHoldings).not.toHaveBeenCalledWith(
        OTHER_USER_ID,
        TOKEN,
        PORTFOLIO_2,
      );
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(OTHER_USER_ID, PORTFOLIO_2)).toEqual(
        [],
      );
      expect(service.getPortfolioSymbols(OTHER_USER_ID, PORTFOLIO_2)).toEqual(
        [],
      );
      expect(service.symbolReferenceCount('MSFT')).toBe(0);

      // (6) The same socket can still subscribe again as user A.
      const again = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(again.kind).toBe('subscribed');
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      // (7) (8) Disconnect removes the identity along with its subscriptions.
      service.disconnect(SOCKET_A);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);

      // (9) The id may now be registered again, as a genuinely fresh connection.
      const fresh = await subscribe(
        service,
        SOCKET_A,
        OTHER_USER_ID,
        PORTFOLIO_2,
      );
      expect(fresh.kind).toBe('subscribed');
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: OTHER_USER_ID, portfolioId: PORTFOLIO_2, state: 'ACTIVE' },
      ]);
      expect(service.getPortfolioSymbols(OTHER_USER_ID, PORTFOLIO_2)).toEqual([
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);

      // (10) Repeated and unknown disconnects stay harmless.
      service.disconnect(SOCKET_A);
      service.disconnect(SOCKET_A);
      service.disconnect('never-connected-socket');
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.symbolReferenceCount('MSFT')).toBe(0);
    });

    it('keeps the idle identity after a failed subscription rolls back', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockRejectedValue(
        new NotFoundException('Portfolio not found.'),
      );

      await expect(
        subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(NotFoundException);

      // The rolled-back attempt left no subscription behind...
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);

      // ...but the socket is still bound to user A, so a different identity on
      // the same id is rejected rather than registering a second user.
      await expect(
        subscribe(service, SOCKET_A, OTHER_USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(ConflictException);

      // User A may retry on its own identity.
      valuation.getValuationHoldings.mockResolvedValue(holdings('AAPL'));
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));
      const retry = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(retry.kind).toBe('subscribed');
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      // Only disconnect clears the binding.
      service.disconnect(SOCKET_A);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });

    it('keeps the idle identity after a transport rollback', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      const result = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(result.kind).toBe('subscribed');
      if (result.kind !== 'subscribed') throw new Error('expected subscribed');

      // Transport failure after activation: only the matching attempt is removed.
      service.rollbackSubscription(
        SOCKET_A,
        USER_ID,
        PORTFOLIO_1,
        result.attemptId,
      );
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);

      // The socket remains an idle authenticated socket for user A.
      await expect(
        subscribe(service, SOCKET_A, OTHER_USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(ConflictException);
      const retry = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(retry.kind).toBe('subscribed');
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      service.disconnect(SOCKET_A);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });
  });

  describe('portfolio + symbol activation', () => {
    it('activates one portfolio and its symbols for the first socket', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL', 'MSFT']);

      const result = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(result).toMatchObject({ kind: 'subscribed' });
      if (result.kind !== 'subscribed') throw new Error('expected subscribed');
      expect(result.valuation).toEqual(valuationFor(PORTFOLIO_1));
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1))).toEqual([
        'AAPL',
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
    });

    it('does not double-count symbols when a second socket joins the same portfolio', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL', 'MSFT']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);

      // Two sockets, one active portfolio, one symbol reference each.
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
        SOCKET_B,
      ]);
      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1))).toEqual([
        'AAPL',
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
    });

    it('counts one reference per portfolio when two portfolios share a symbol', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockImplementation(
        (_userId: string, _token: string, portfolioId: string) =>
          Promise.resolve(
            portfolioId === PORTFOLIO_1
              ? holdings('AAPL', 'MSFT')
              : holdings('AAPL'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_2);

      expect(service.symbolReferenceCount('AAPL')).toBe(2);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_2))).toEqual([
        'AAPL',
      ]);
    });

    it('duplicate holdings within a portfolio cannot double-count a symbol', async () => {
      const { valuation, service } = makeService();
      // Two rows for AAPL (would not normally be stored, but must be handled).
      valuation.getValuationHoldings.mockResolvedValue([
        holding('AAPL'),
        holding('aapl'),
        holding('MSFT'),
      ]);
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1))).toEqual([
        'AAPL',
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
    });
  });

  describe('removal and cleanup', () => {
    it('keeps a portfolio active while any socket remains', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_B,
      ]);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([
        'AAPL',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
    });

    it('removes the portfolio and its symbol references when the last socket leaves', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      service.unsubscribe(SOCKET_B, USER_ID, PORTFOLIO_1);

      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getSocketSubscriptions(SOCKET_B)).toEqual([]);
    });

    it('disconnect removes every subscription belonging to that socket only', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockImplementation(
        (_userId: string, _token: string, portfolioId: string) =>
          Promise.resolve(
            portfolioId === PORTFOLIO_1
              ? holdings('AAPL', 'MSFT')
              : holdings('AAPL'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_2);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);

      service.disconnect(SOCKET_A);

      // Socket A is fully gone; portfolio 1 survives via socket B; portfolio 2
      // (A-only) is cleaned up with its symbol references.
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_B,
      ]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_2)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1); // portfolio 1 only
      expect(service.symbolReferenceCount('MSFT')).toBe(1);
      expect(service.getSocketSubscriptions(SOCKET_B)).toHaveLength(1);
    });

    it('disconnect of one socket does not affect another socket of the same user', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);
      service.disconnect(SOCKET_A);

      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_B,
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.getSocketSubscriptions(SOCKET_B)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
    });
  });

  describe('duplicate detection', () => {
    it('a sequential duplicate performs no second valuation', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      const first = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(first.kind).toBe('subscribed');
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);

      const second = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(second).toEqual({ kind: 'duplicate' });
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);
    });

    it('a concurrent duplicate while the first attempt is pending performs no second authorization or valuation', async () => {
      const { valuation, service } = makeService();
      const gate = deferred<ValuationHolding[]>();
      valuation.getValuationHoldings.mockReturnValue(gate.promise);
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      const first = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);

      const second = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(second).toEqual({ kind: 'duplicate' });
      // No second authorization or valuation pass, and nothing emitted yet.
      expect(valuation.getValuationHoldings).toHaveBeenCalledTimes(1);
      expect(valuation.valueHoldings).not.toHaveBeenCalled();

      gate.resolve(holdings('AAPL'));
      const firstResult = await first;
      expect(firstResult.kind).toBe('subscribed');
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure rollback and retry', () => {
    it('rolls back pending state when authorization fails', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockRejectedValue(
        new NotFoundException('Portfolio not found.'),
      );

      await expect(
        subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(valuation.valueHoldings).not.toHaveBeenCalled();
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });

    it('rolls back pending state when valuation fails', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockResolvedValue(holdings('AAPL'));
      valuation.valueHoldings.mockRejectedValue(
        new ServiceUnavailableException('provider down'),
      );

      await expect(
        subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });

    it('a retry after failure succeeds', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockResolvedValue(holdings('AAPL'));
      valuation.valueHoldings
        .mockRejectedValueOnce(new ServiceUnavailableException('down'))
        .mockResolvedValueOnce(valuationFor(PORTFOLIO_1));

      await expect(
        subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const retry = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(retry.kind).toBe('subscribed');
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
    });
  });

  describe('cancellation during in-flight work', () => {
    it('unsubscribe during pending authorization prevents activation', async () => {
      const { valuation, service } = makeService();
      const gate = deferred<ValuationHolding[]>();
      valuation.getValuationHoldings.mockReturnValue(gate.promise);
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      const pending = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();

      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      gate.resolve(holdings('AAPL'));

      const result = await pending;
      expect(result).toEqual({ kind: 'obsolete' });
      expect(valuation.valueHoldings).not.toHaveBeenCalled();
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });

    it('unsubscribe during pending valuation prevents activation', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockResolvedValue(holdings('AAPL'));
      const gate = deferred<PortfolioValuationDto>();
      valuation.valueHoldings.mockReturnValue(gate.promise);

      const pending = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);

      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      gate.resolve(valuationFor(PORTFOLIO_1));

      const result = await pending;
      expect(result).toEqual({ kind: 'obsolete' });
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });

    it('disconnect during pending authorization prevents activation', async () => {
      const { valuation, service } = makeService();
      const gate = deferred<ValuationHolding[]>();
      valuation.getValuationHoldings.mockReturnValue(gate.promise);
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      const pending = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();

      service.disconnect(SOCKET_A);
      gate.resolve(holdings('AAPL'));

      const result = await pending;
      expect(result).toEqual({ kind: 'obsolete' });
      expect(valuation.valueHoldings).not.toHaveBeenCalled();
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
    });

    it('disconnect during pending valuation prevents activation', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockResolvedValue(holdings('AAPL'));
      const gate = deferred<PortfolioValuationDto>();
      valuation.valueHoldings.mockReturnValue(gate.promise);

      const pending = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();

      service.disconnect(SOCKET_A);
      gate.resolve(valuationFor(PORTFOLIO_1));

      const result = await pending;
      expect(result).toEqual({ kind: 'obsolete' });
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
    });

    it('an obsolete attempt cannot delete or activate over a newer retry', async () => {
      const { valuation, service } = makeService();
      const firstGate = deferred<ValuationHolding[]>();
      const retryGate = deferred<ValuationHolding[]>();
      valuation.getValuationHoldings
        .mockReturnValueOnce(firstGate.promise)
        .mockReturnValueOnce(retryGate.promise);
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      // Attempt 1 parks on authorization.
      const first = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);

      // A newer retry (attempt 2) parks on its own authorization.
      const retry = subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await flush();

      // Attempt 1 resumes and must recognise itself as obsolete: it must not
      // delete the retry's entry, activate anything, or run a valuation.
      firstGate.resolve(holdings('AAPL'));
      const firstResult = await first;
      expect(firstResult).toEqual({ kind: 'obsolete' });
      expect(valuation.valueHoldings).not.toHaveBeenCalled();
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'PENDING' },
      ]);

      // The newer retry is untouched and completes normally.
      retryGate.resolve(holdings('AAPL'));
      const retryResult = await retry;
      expect(retryResult.kind).toBe('subscribed');
      expect(valuation.valueHoldings).toHaveBeenCalledTimes(1);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
    });
  });

  describe('transport rollback', () => {
    it('removes only the matching attempt, never a newer replacement', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      const first = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(first.kind).toBe('subscribed');
      if (first.kind !== 'subscribed') throw new Error('expected subscribed');
      const firstAttemptId = first.attemptId;

      // The socket unsubscribed and a newer retry replaced the old attempt.
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      const retry = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(retry.kind).toBe('subscribed');
      if (retry.kind !== 'subscribed') throw new Error('expected subscribed');
      const retryAttemptId = retry.attemptId;
      expect(retryAttemptId).not.toBe(firstAttemptId);

      // Rolling back the obsolete first attempt leaves the newer one active.
      service.rollbackSubscription(
        SOCKET_A,
        USER_ID,
        PORTFOLIO_1,
        firstAttemptId,
      );
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      // Rolling back the matching attempt removes the subscription and cleans up.
      service.rollbackSubscription(
        SOCKET_A,
        USER_ID,
        PORTFOLIO_1,
        retryAttemptId,
      );
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });
  });

  describe('symbol snapshot reconciliation', () => {
    it('handles added, removed, unchanged, duplicated, and empty symbols', async () => {
      const { valuation, service } = makeService();
      const sequences = [
        holdings('AAPL', 'MSFT'),
        holdings('AAPL'), // MSFT removed
        holdings('AAPL', 'MSFT', 'AAPL'), // duplicate AAPL, MSFT re-added
        holdings(), // empty
      ];
      let call = 0;
      valuation.getValuationHoldings.mockImplementation(() =>
        Promise.resolve(sequences[Math.min(call++, sequences.length - 1)]),
      );
      valuation.valueHoldings.mockResolvedValue(valuationFor(PORTFOLIO_1));

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1))).toEqual([
        'AAPL',
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);

      // New socket, holdings changed: MSFT is removed once, AAPL untouched.
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([
        'AAPL',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(0);

      // MSFT returns and AAPL appears twice in the input: no double-count.
      await subscribe(service, SOCKET_C, USER_ID, PORTFOLIO_1);
      expect(sort(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1))).toEqual([
        'AAPL',
        'MSFT',
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.symbolReferenceCount('MSFT')).toBe(1);

      // An empty portfolio empties its snapshot; the portfolio stays active.
      await subscribe(service, SOCKET_D, USER_ID, PORTFOLIO_1);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
      expect(service.symbolReferenceCount('MSFT')).toBe(0);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
        SOCKET_B,
        SOCKET_C,
        SOCKET_D,
      ]);
    });

    it('keeps a shared symbol referenced by the portfolio that still requires it', async () => {
      const { valuation, service } = makeService();
      // P1's first read requires AAPL, its later read no longer does; P2 always
      // requires AAPL.
      let p1Reads = 0;
      valuation.getValuationHoldings.mockImplementation(
        (_userId: string, _token: string, portfolioId: string) => {
          if (portfolioId === PORTFOLIO_2) {
            return Promise.resolve(holdings('AAPL'));
          }
          p1Reads += 1;
          return Promise.resolve(p1Reads === 1 ? holdings('AAPL') : holdings());
        },
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      // P1 and P2 both require AAPL: two distinct portfolio references.
      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_2);
      expect(service.symbolReferenceCount('AAPL')).toBe(2);

      // P1 later reconciles to a holdings set that no longer contains AAPL.
      await subscribe(service, SOCKET_C, USER_ID, PORTFOLIO_1);

      // AAPL stays active on P2's reference alone.
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([]);
      // P2's own symbol state and socket set are untouched.
      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_2)).toEqual([
        'AAPL',
      ]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_2)).toEqual([
        SOCKET_B,
      ]);
      // The surviving reference is P2's: releasing P2 clears the symbol, so P1
      // cannot have left a stale one behind.
      service.unsubscribe(SOCKET_B, USER_ID, PORTFOLIO_2);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
    });
  });

  describe('active symbol inspection', () => {
    it('returns no symbols for an idle registry', () => {
      const { service } = makeService();
      expect(service.getActiveSymbols()).toEqual([]);
    });

    it('returns a fresh, normalized, sorted snapshot of active symbols', async () => {
      const { valuation, service } = makeService();
      // Raw casing in the provider rows must not leak into the snapshot.
      stubHoldings(valuation, ['msft', 'AAPL']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(service.getActiveSymbols()).toEqual(['AAPL', 'MSFT']);

      // A fresh copy: mutating what a caller received cannot corrupt the
      // registry's own symbol index.
      const snapshot = service.getActiveSymbols();
      snapshot.push('HACK');
      snapshot.length = 0;
      expect(service.getActiveSymbols()).toEqual(['AAPL', 'MSFT']);
    });

    it('lists a shared symbol once and drops it when its last portfolio releases it', async () => {
      const { valuation, service } = makeService();
      valuation.getValuationHoldings.mockImplementation(
        (_userId: string, _token: string, portfolioId: string) =>
          Promise.resolve(
            portfolioId === PORTFOLIO_1
              ? holdings('AAPL')
              : holdings('AAPL', 'MSFT'),
          ),
      );
      valuation.valueHoldings.mockImplementation((portfolioId: string) =>
        Promise.resolve(valuationFor(portfolioId)),
      );

      // Two portfolios both require AAPL; only P2 requires MSFT.
      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_2);
      expect(service.getActiveSymbols()).toEqual(['AAPL', 'MSFT']);
      expect(service.symbolReferenceCount('AAPL')).toBe(2);

      // P1 releases AAPL, but P2 still requires it — the symbol stays active.
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(service.getActiveSymbols()).toEqual(['AAPL', 'MSFT']);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);

      // P2 holds the last references, so both symbols go.
      service.unsubscribe(SOCKET_B, USER_ID, PORTFOLIO_2);
      expect(service.getActiveSymbols()).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);
      expect(service.symbolReferenceCount('MSFT')).toBe(0);
    });

    it('omits symbols of a portfolio that holds nothing', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, []);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(service.getActiveSymbols()).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
      ]);
    });
  });

  describe('inspection boundaries', () => {
    it('never leaks internal mutable maps or sets through inspection methods', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      await subscribe(service, SOCKET_B, USER_ID, PORTFOLIO_1);

      // Mutating a returned copy must not corrupt the registry.
      const symbols = service.getPortfolioSymbols(USER_ID, PORTFOLIO_1);
      symbols.push('HACK');
      const sockets = service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1);
      sockets.push('HACK');
      const snapshots = service.getSocketSubscriptions(SOCKET_A);
      snapshots.push({
        userId: 'HACK',
        portfolioId: 'HACK',
        state: 'ACTIVE',
      });

      expect(service.getPortfolioSymbols(USER_ID, PORTFOLIO_1)).toEqual([
        'AAPL',
      ]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([
        SOCKET_A,
        SOCKET_B,
      ]);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([
        { userId: USER_ID, portfolioId: PORTFOLIO_1, state: 'ACTIVE' },
      ]);
      expect(service.symbolReferenceCount('AAPL')).toBe(1);
    });
  });

  describe('idempotent lifecycle calls', () => {
    it('repeated unsubscribe and disconnect are harmless and leave no state', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      // Calls on a fresh registry.
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      service.disconnect(SOCKET_A);
      service.disconnect(SOCKET_A);
      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);

      // Subscribe, then a mix of repeated unsubscribe/disconnect.
      const result = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(result.kind).toBe('subscribed');
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      service.disconnect(SOCKET_A);
      service.disconnect(SOCKET_A);
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);

      expect(service.getSocketSubscriptions(SOCKET_A)).toEqual([]);
      expect(service.getPortfolioSocketIds(USER_ID, PORTFOLIO_1)).toEqual([]);
      expect(service.symbolReferenceCount('AAPL')).toBe(0);

      // A subsequent fresh subscribe is still allowed.
      const again = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(again.kind).toBe('subscribed');
    });

    it('confirmActive reflects live ACTIVE state for the exact attempt only', async () => {
      const { valuation, service } = makeService();
      stubHoldings(valuation, ['AAPL']);

      // No registry entry for a never-subscribed socket/portfolio.
      expect(
        service.confirmActive(SOCKET_A, USER_ID, PORTFOLIO_1, attemptId(1)),
      ).toBe(false);

      const first = await subscribe(service, SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(first.kind).toBe('subscribed');
      if (first.kind !== 'subscribed') throw new Error('expected subscribed');
      const attempt = first.attemptId;

      // The live active attempt confirms.
      expect(
        service.confirmActive(SOCKET_A, USER_ID, PORTFOLIO_1, attempt),
      ).toBe(true);
      // A mismatched attempt id never confirms, even while the socket is active.
      expect(
        service.confirmActive(
          SOCKET_A,
          USER_ID,
          PORTFOLIO_1,
          (attempt + 1) as SubscriptionAttemptId,
        ),
      ).toBe(false);
      // A different portfolio on the same socket is absent.
      expect(
        service.confirmActive(SOCKET_A, USER_ID, PORTFOLIO_2, attempt),
      ).toBe(false);

      // After unsubscribe the previously-active attempt no longer confirms.
      service.unsubscribe(SOCKET_A, USER_ID, PORTFOLIO_1);
      expect(
        service.confirmActive(SOCKET_A, USER_ID, PORTFOLIO_1, attempt),
      ).toBe(false);
    });
  });
});
