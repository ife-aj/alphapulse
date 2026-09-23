import { ConflictException, Injectable } from '@nestjs/common';
import { normalizeSymbol } from '../market/validation/symbol.validation';
import type { PortfolioValuationDto } from '../portfolios/dto/valuation-response.dto';
import { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import type { ValuationHolding } from '../portfolios/valuation-computation';
import type { ActivePortfolioIdentity } from './realtime.types';

/**
 * Neutral message for a socket that presents a user id other than the one it
 * registered with. It names neither identity — only the server-side log sees it,
 * and the gateway maps the 409 onto its existing generic `INTERNAL_ERROR`
 * acknowledgement, whose message is a fixed constant.
 */
const IDENTITY_MISMATCH_MESSAGE = 'Subscription identity mismatch.';

/**
 * Opaque identity of a single `PENDING → ACTIVE` subscription attempt.
 *
 * A monotonic counter hands out a fresh value for every reservation, and every
 * await in the subscribe lifecycle re-checks that the currently stored entry
 * still carries this same value. That check — conceptually
 * `currentEntry?.attemptId === thisAttemptId` — is what lets an old, unresolved
 * attempt recognise itself as obsolete after an unsubscribe, disconnect, or a
 * newer retry, so it can neither activate nor mutate the newer state.
 */
export type SubscriptionAttemptId = number & {
  readonly __subscriptionAttemptId: unique symbol;
};

/**
 * A canonical, deterministic, internal identity for one authenticated
 * `(userId, portfolioId)` pair.
 *
 * JavaScript compares object keys by reference, so a hand-rolled
 * `{ userId, portfolioId }` object could never be used as a `Map`/`Set` key —
 * two separately constructed objects holding equal values would not match. This
 * branded string is the single construction point (`makePortfolioKey`) and is
 * derived only from the authenticated `userId` and the validated portfolio UUID.
 * It is deliberately separate from the Socket.IO room name and is never exposed
 * publicly.
 */
type PortfolioKey = string & { readonly __portfolioKey: unique symbol };

/** The only place a `PortfolioKey` is built. */
function makePortfolioKey(userId: string, portfolioId: string): PortfolioKey {
  // JSON-array encoding is unambiguous for arbitrary string contents: there is
  // no delimiter that `userId = "a"` + `portfolioId = "b:c"` could share with
  // `userId = "a:b"` + `portfolioId = "c"`.
  return JSON.stringify([userId, portfolioId]) as PortfolioKey;
}

/** A live subscription on one socket: pending (reserved, unresolved) or active. */
type SubscriptionState = 'PENDING' | 'ACTIVE';

/**
 * Deterministic ordering for active-portfolio snapshots: user id, then
 * portfolio id. Deliberately compared by code unit rather than
 * `localeCompare`, whose ordering depends on the runtime's locale and would
 * make cycle output environment-dependent.
 */
function comparePortfolioIdentities(
  a: ActivePortfolioIdentity,
  b: ActivePortfolioIdentity,
): number {
  if (a.userId !== b.userId) {
    return a.userId < b.userId ? -1 : 1;
  }
  if (a.portfolioId !== b.portfolioId) {
    return a.portfolioId < b.portfolioId ? -1 : 1;
  }
  return 0;
}

/** The per-(socket, portfolio) entry the state machine lives on. */
interface SocketSubscription {
  /** The validated portfolio UUID (kept so snapshots need not decode keys). */
  portfolioId: string;
  attemptId: SubscriptionAttemptId;
  state: SubscriptionState;
}

/**
 * Per-socket registry identity, created on the socket's first subscription and
 * removed only by `disconnect`. Socket objects and access tokens are never
 * stored here — an entry may legitimately outlive every subscription it holds.
 */
interface SocketIdentity {
  /** Fixed at registration; never rewritten for the life of this entry. */
  userId: string;
  /** portfolio key → that socket's subscription. Absence is the REMOVED state. */
  subscriptions: Map<PortfolioKey, SocketSubscription>;
}

/**
 * An active portfolio: one portfolio (unique per authenticated user) that at
 * least one socket is actively subscribed to. Stores only the identity and the
 * symbol snapshot a future poller needs — never holdings Decimals, valuations,
 * or access tokens.
 */
interface ActivePortfolio {
  /**
   * The authenticated identity ownership is proven against, copied from the
   * socket entry at activation. Held here (rather than decoded from the
   * portfolio key) so enumeration needs no key parser and `makePortfolioKey`
   * stays the only place a key is ever built.
   */
  userId: string;
  /** The validated portfolio UUID, also copied from the subscription entry. */
  portfolioId: string;
  /** Socket ids currently actively subscribed. Two sockets = one portfolio. */
  socketIds: Set<string>;
  /** Normalized, deduplicated symbol snapshot (counted once per portfolio). */
  symbols: Set<string>;
}

/** Read-only snapshot of one socket's subscriptions (fresh copies, never the live maps). */
export interface SocketSubscriptionSnapshot {
  userId: string;
  portfolioId: string;
  state: 'PENDING' | 'ACTIVE';
}

/**
 * Outcome of a subscribe attempt, consumed by the gateway.
 *
 *  - `duplicate`: this socket already has a pending or active subscription for
 *    the portfolio — acknowledge `subscribed: false`, do nothing else.
 *  - `obsolete`: the attempt was cancelled mid-flight (unsubscribe, disconnect,
 *    or a newer retry) and must neither activate, join a room, nor emit.
 *  - `subscribed`: the attempt committed; the gateway confirms the exact
 *    `attemptId` is still active before any transport work, then joins/emits.
 */
export type RealtimeSubscribeResult =
  | { kind: 'duplicate' }
  | { kind: 'obsolete' }
  | {
      kind: 'subscribed';
      attemptId: SubscriptionAttemptId;
      valuation: PortfolioValuationDto;
    };

/**
 * Centralized realtime subscription registry and lifecycle state machine.
 *
 * Replaces the gateway's per-socket `portfolioIds` bookkeeping. The registry
 * owns every subscription state transition and the derived indexes:
 *
 *   socket id        → authenticated user + subscriptions
 *   portfolio key    → active socket ids + normalized symbol snapshot
 *   normalized symbol → active portfolio keys holding that symbol
 *
 * The socket entry is the identity boundary: its user id is written once, on the
 * socket's first subscription, and every later call for that socket must present
 * the same authenticated id. A mismatch is rejected before any state is touched,
 * so a supplied id can never address or create another user's registry state.
 *
 * Identity lifetime equals connection lifetime. The entry holds only
 * `{ userId, subscriptions }` — never an access token or a Socket.IO socket
 * object — and survives until `disconnect(socketId)`: removing the last
 * subscription, or rolling back a failed or superseded attempt, empties the
 * entry but leaves the socket registered as an *idle authenticated socket*, so
 * it cannot later be re-registered under a different user. Only `disconnect`
 * removes the entry, after which the same socket id may be registered again as a
 * genuinely fresh connection.
 *
 * A portfolio is *active* when at least one socket is actively subscribed; two
 * sockets watching the same portfolio still represent one active portfolio, and
 * symbols are counted once per active portfolio (the symbol index stores
 * `Set<PortfolioKey>`, so a reference count is a set size and can never go
 * negative or double-count). Rooms remain a gateway/Socket.IO concern and are
 * never registry identifiers.
 *
 * Token boundary: the gateway passes the per-socket access token transiently
 * into `subscribe(...)`, where it is used for the one authorization + holdings
 * load and is never retained — not in socket indexes, portfolio entries, symbol
 * entries, logs, errors, or DTOs. The future polling slice must resolve a
 * credential from a *currently connected subscriber* rather than permanently
 * attaching the first socket's token to an active portfolio.
 */
@Injectable()
export class RealtimeSubscriptionService {
  private readonly sockets = new Map<string, SocketIdentity>();
  private readonly activePortfolios = new Map<PortfolioKey, ActivePortfolio>();
  private readonly symbolPortfolios = new Map<string, Set<PortfolioKey>>();
  private nextAttemptId = 0;

  constructor(private readonly valuationService: PortfoliosValuationService) {}

  /**
   * Authorize, value, and activate one subscription for a socket.
   *
   * The reservation is taken synchronously before the first await, and the
   * attempt identity is re-confirmed after every awaited phase:
   *
   *   reserve PENDING → getValuationHoldings → confirm → valueHoldings →
   *   confirm → commit ACTIVE (+ socket + symbol snapshot).
   *
   * An authorization or valuation failure rolls the reservation back (only if
   * this exact attempt is still current) and rethrows, so the gateway's
   * existing error mapping is unchanged. A cancelled attempt resolves to
   * `obsolete` instead of activating.
   *
   * The socket's *registered* identity is authoritative: a call whose supplied
   * `userId` disagrees with it is rejected with a neutral 409 before the
   * reservation, the provider calls, and every index mutation below, so no
   * cross-user subscription state can be constructed.
   */
  async subscribe(input: {
    socketId: string;
    userId: string;
    /** Transient per-socket credential — used once, never retained. */
    accessToken: string;
    portfolioId: string;
  }): Promise<RealtimeSubscribeResult> {
    const { socketId, userId, accessToken, portfolioId } = input;
    const identity = this.ensureSocket(socketId, userId);

    // A socket's first registration fixes its identity, and a later call must
    // present the same authenticated user id. A mismatch is an internal
    // identity-consistency failure — the caller's identity disagrees with the
    // registry's, rather than a portfolio authorization outcome — so it is
    // rejected here and names neither user id.
    if (identity.userId !== userId) {
      throw new ConflictException(IDENTITY_MISMATCH_MESSAGE);
    }

    // The registered identity is the single source of truth: the portfolio key
    // is derived from it, never from the supplied id, so a mismatched caller
    // cannot address — or create — another user's portfolio state.
    const key = makePortfolioKey(identity.userId, portfolioId);

    // A socket has at most one live subscription per (user, portfolio). A
    // pending attempt or an active subscription both make this a duplicate —
    // no second authorization, valuation, or provider call.
    if (identity.subscriptions.has(key)) {
      return { kind: 'duplicate' };
    }

    // Reserve synchronously, before the first await. The attempt id is unique
    // per reservation, so any later resume belongs to exactly one attempt.
    const attemptId = this.nextAttempt();
    identity.subscriptions.set(key, {
      portfolioId,
      attemptId,
      state: 'PENDING',
    });

    let holdings: ValuationHolding[];
    try {
      holdings = await this.valuationService.getValuationHoldings(
        userId,
        accessToken,
        portfolioId,
      );
    } catch (error) {
      this.rollbackIfCurrent(socketId, key, attemptId);
      throw error;
    }
    if (!this.isCurrent(socketId, key, attemptId)) {
      return { kind: 'obsolete' };
    }

    let valuation: PortfolioValuationDto;
    try {
      valuation = await this.valuationService.valueHoldings(
        portfolioId,
        holdings,
      );
    } catch (error) {
      this.rollbackIfCurrent(socketId, key, attemptId);
      throw error;
    }
    if (!this.isCurrent(socketId, key, attemptId)) {
      return { kind: 'obsolete' };
    }

    this.commit(socketId, key, attemptId, holdings);
    return { kind: 'subscribed', attemptId, valuation };
  }

  /**
   * Idempotently remove one subscription. Reveals nothing about whether it was
   * tracked. A pending attempt is cancelled (its later resume sees no matching
   * entry); an active subscription drops the socket from the portfolio, keeping
   * the portfolio and symbols alive while other sockets remain.
   *
   * Subscription state only: the socket's registered identity survives, so a
   * socket with zero subscriptions stays registered as an idle authenticated
   * socket until `disconnect(socketId)`.
   */
  unsubscribe(socketId: string, userId: string, portfolioId: string): void {
    const key = makePortfolioKey(userId, portfolioId);
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return;
    }
    if (identity.subscriptions.delete(key)) {
      this.releasePortfolioSocket(key, socketId);
    }
  }

  /**
   * Cancel every pending attempt and remove every active subscription belonging
   * to one socket, applying last-socket portfolio cleanup. Never affects other
   * sockets of the same user, never retains tokens or socket objects, and is a
   * no-op for sockets that never authenticated or already disconnected.
   */
  disconnect(socketId: string): void {
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return;
    }
    for (const key of [...identity.subscriptions.keys()]) {
      identity.subscriptions.delete(key);
      this.releasePortfolioSocket(key, socketId);
    }
    this.sockets.delete(socketId);
  }

  /**
   * Authoritative "is this exact attempt still the live, active subscription?"
   * The gateway calls this after `subscribe` resolves and again after the room
   * join, before any valuation is emitted.
   */
  confirmActive(
    socketId: string,
    userId: string,
    portfolioId: string,
    attemptId: SubscriptionAttemptId,
  ): boolean {
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return false;
    }
    const entry = identity.subscriptions.get(
      makePortfolioKey(userId, portfolioId),
    );
    return (
      entry !== undefined &&
      entry.state === 'ACTIVE' &&
      entry.attemptId === attemptId
    );
  }

  /**
   * Transport-failure rollback: remove only the subscription matching this
   * exact attempt. If a newer retry replaced it, this is a no-op — an obsolete
   * attempt never deletes a newer one. The socket's identity is not touched: a
   * rolled-back attempt reverts to the idle authenticated state its socket had
   * before the attempt, never to an unregistered one.
   */
  rollbackSubscription(
    socketId: string,
    userId: string,
    portfolioId: string,
    attemptId: SubscriptionAttemptId,
  ): void {
    const key = makePortfolioKey(userId, portfolioId);
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return;
    }
    const entry = identity.subscriptions.get(key);
    if (entry === undefined || entry.attemptId !== attemptId) {
      return;
    }
    identity.subscriptions.delete(key);
    this.releasePortfolioSocket(key, socketId);
  }

  // --- Read-only inspection (fresh copies; the live maps/sets never escape) ---

  /** Snapshot of one socket's subscriptions, in insertion order. */
  getSocketSubscriptions(socketId: string): SocketSubscriptionSnapshot[] {
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return [];
    }
    const snapshots: SocketSubscriptionSnapshot[] = [];
    for (const entry of identity.subscriptions.values()) {
      snapshots.push({
        userId: identity.userId,
        portfolioId: entry.portfolioId,
        state: entry.state,
      });
    }
    return snapshots;
  }

  /** Socket ids actively subscribed to a portfolio (empty when not active). */
  getPortfolioSocketIds(userId: string, portfolioId: string): string[] {
    const portfolio = this.activePortfolios.get(
      makePortfolioKey(userId, portfolioId),
    );
    return portfolio ? [...portfolio.socketIds] : [];
  }

  /** Normalized symbol snapshot of an active portfolio (empty when not active). */
  getPortfolioSymbols(userId: string, portfolioId: string): string[] {
    const portfolio = this.activePortfolios.get(
      makePortfolioKey(userId, portfolioId),
    );
    return portfolio ? [...portfolio.symbols] : [];
  }

  /**
   * Number of active portfolios requiring a symbol — a `Set<PortfolioKey>` size
   * that can never double-count a portfolio or go negative.
   */
  symbolReferenceCount(symbol: string): number {
    return this.symbolPortfolios.get(normalizeSymbol(symbol))?.size ?? 0;
  }

  /**
   * Every normalized symbol currently required by at least one active portfolio
   * — the input a refresh cycle fetches, each symbol once regardless of how many
   * portfolios hold it.
   *
   * The symbol index is the source of truth: `dropPortfolioSymbol` deletes an
   * entry as soon as its last portfolio releases it, so these keys are exactly
   * the live symbols (a portfolio with no holdings contributes none).
   *
   * Sorted, because the index's insertion order follows subscription history and
   * would otherwise make the snapshot's ordering depend on it. A fresh array:
   * mutating the result cannot corrupt the registry.
   */
  getActiveSymbols(): string[] {
    return [...this.symbolPortfolios.keys()].sort();
  }

  /**
   * Every active portfolio's authenticated identity — the starting snapshot of
   * one recalculation cycle.
   *
   * A fresh array of fresh objects: a subscription change made while a cycle
   * runs cannot mutate the set being processed, so that change belongs to the
   * next cycle. One entry per active portfolio regardless of how many sockets
   * are watching it, and portfolios whose only subscriptions are still pending
   * contribute nothing.
   *
   * The identity is read off the entry, never decoded from the portfolio key,
   * so `makePortfolioKey` remains the single construction point and there is no
   * parser that could drift from its encoding.
   *
   * Deliberately excludes socket ids, room names, and symbol snapshots: who
   * receives a result is a transport concern, and the symbols to price come
   * from freshly loaded holdings. Sorted by identity, because the map's own
   * insertion order follows subscription history and would otherwise leak into
   * cycle output.
   */
  getActivePortfolioIdentities(): ActivePortfolioIdentity[] {
    const identities: ActivePortfolioIdentity[] = [];
    for (const portfolio of this.activePortfolios.values()) {
      identities.push({
        userId: portfolio.userId,
        portfolioId: portfolio.portfolioId,
      });
    }
    return identities.sort(comparePortfolioIdentities);
  }

  // --- Internal lifecycle helpers ---

  /**
   * The socket's registry identity, created on first use and never rewritten: an
   * entry that already exists keeps the user id it was registered with, so the
   * stored identity always wins over a later caller-supplied one. Callers compare
   * the returned identity against the id they were given rather than replacing it.
   */
  private ensureSocket(socketId: string, userId: string): SocketIdentity {
    let identity = this.sockets.get(socketId);
    if (!identity) {
      identity = { userId, subscriptions: new Map() };
      this.sockets.set(socketId, identity);
    }
    return identity;
  }

  private nextAttempt(): SubscriptionAttemptId {
    this.nextAttemptId += 1;
    return this.nextAttemptId as SubscriptionAttemptId;
  }

  private isCurrent(
    socketId: string,
    key: PortfolioKey,
    attemptId: SubscriptionAttemptId,
  ): boolean {
    const entry = this.sockets.get(socketId)?.subscriptions.get(key);
    return entry !== undefined && entry.attemptId === attemptId;
  }

  /**
   * Delete a pending reservation, only when it still belongs to this attempt.
   * Subscription state only — the socket stays registered and authenticated.
   */
  private rollbackIfCurrent(
    socketId: string,
    key: PortfolioKey,
    attemptId: SubscriptionAttemptId,
  ): void {
    const identity = this.sockets.get(socketId);
    if (!identity) {
      return;
    }
    const entry = identity.subscriptions.get(key);
    if (entry === undefined || entry.attemptId !== attemptId) {
      return;
    }
    identity.subscriptions.delete(key);
  }

  /** Mark the attempt ACTIVE and register its socket + symbol snapshot. */
  private commit(
    socketId: string,
    key: PortfolioKey,
    attemptId: SubscriptionAttemptId,
    holdings: readonly ValuationHolding[],
  ): void {
    const identity = this.sockets.get(socketId);
    const entry = identity?.subscriptions.get(key);
    if (
      identity === undefined ||
      entry === undefined ||
      entry.attemptId !== attemptId
    ) {
      return; // defensive: single-threaded, but never commit an obsolete attempt
    }
    entry.state = 'ACTIVE';

    let portfolio = this.activePortfolios.get(key);
    if (!portfolio) {
      portfolio = {
        // The registered identity and the validated portfolio UUID — the same
        // pair the key was derived from, so enumeration never has to parse it.
        userId: identity.userId,
        portfolioId: entry.portfolioId,
        socketIds: new Set(),
        symbols: new Set(),
      };
      this.activePortfolios.set(key, portfolio);
    }
    portfolio.socketIds.add(socketId);
    this.reconcileSymbols(key, portfolio, holdings);
  }

  /**
   * Reconcile a portfolio's symbol snapshot against freshly authorized holdings.
   * Added symbols get the portfolio key once; removed symbols release it once;
   * unchanged symbols are untouched; duplicate holdings cannot double-count.
   */
  private reconcileSymbols(
    key: PortfolioKey,
    portfolio: ActivePortfolio,
    holdings: readonly ValuationHolding[],
  ): void {
    const next = new Set<string>();
    for (const holding of holdings) {
      next.add(normalizeSymbol(holding.symbol));
    }

    for (const symbol of portfolio.symbols) {
      if (!next.has(symbol)) {
        this.dropPortfolioSymbol(symbol, key);
        portfolio.symbols.delete(symbol);
      }
    }
    for (const symbol of next) {
      if (!portfolio.symbols.has(symbol)) {
        portfolio.symbols.add(symbol);
        this.addPortfolioSymbol(symbol, key);
      }
    }
  }

  private addPortfolioSymbol(symbol: string, key: PortfolioKey): void {
    let portfolios = this.symbolPortfolios.get(symbol);
    if (!portfolios) {
      portfolios = new Set();
      this.symbolPortfolios.set(symbol, portfolios);
    }
    portfolios.add(key);
  }

  private dropPortfolioSymbol(symbol: string, key: PortfolioKey): void {
    const portfolios = this.symbolPortfolios.get(symbol);
    if (!portfolios) {
      return;
    }
    portfolios.delete(key);
    if (portfolios.size === 0) {
      this.symbolPortfolios.delete(symbol);
    }
  }

  /**
   * Remove one socket from an active portfolio. When it was the last active
   * socket, the portfolio and every symbol reference it contributed are removed
   * and emptied symbol-index entries are deleted. A pending-only removal (the
   * socket never activated) is a no-op.
   */
  private releasePortfolioSocket(key: PortfolioKey, socketId: string): void {
    const portfolio = this.activePortfolios.get(key);
    if (!portfolio) {
      return;
    }
    const wasActive = portfolio.socketIds.delete(socketId);
    if (!wasActive || portfolio.socketIds.size > 0) {
      return;
    }
    for (const symbol of portfolio.symbols) {
      this.dropPortfolioSymbol(symbol, key);
    }
    portfolio.symbols.clear();
    this.activePortfolios.delete(key);
  }
}
