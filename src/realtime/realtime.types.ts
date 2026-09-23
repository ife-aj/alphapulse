import type { Socket } from 'socket.io';
import type Decimal from 'decimal.js';
import type { PortfolioValuationDto } from '../portfolios/dto/valuation-response.dto';

/**
 * Wire contract for the authenticated live portfolio-valuation socket.
 *
 * Only four events exist in this slice:
 *  - Client → server: `portfolio:subscribe`, `portfolio:unsubscribe`.
 *  - Server → client: `portfolio:valuation`, `portfolio:error`.
 *
 * The event names are `as const` literals so they can be used both as the
 * gateway message keys and as the computed property keys of the typed maps
 * below.
 */

export const PORTFOLIO_SUBSCRIBE_EVENT = 'portfolio:subscribe' as const;
export const PORTFOLIO_UNSUBSCRIBE_EVENT = 'portfolio:unsubscribe' as const;
export const PORTFOLIO_VALUATION_EVENT = 'portfolio:valuation' as const;
export const PORTFOLIO_ERROR_EVENT = 'portfolio:error' as const;

/** Payload of both `portfolio:subscribe` and `portfolio:unsubscribe`. */
export interface SubscribePortfolioPayload {
  /** UUID of the portfolio to subscribe to / unsubscribe from. */
  portfolioId: string;
}

/**
 * Errors reported after a connection is established (carried on subscribe /
 * unsubscribe acknowledgements). Messages are neutral: they never expose
 * Supabase, Finnhub, or provider internals.
 */
export type PortfolioSocketErrorCode =
  | 'VALIDATION_ERROR'
  | 'PORTFOLIO_NOT_FOUND'
  | 'MARKET_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface PortfolioSocketError {
  code: PortfolioSocketErrorCode;
  message: string;
}

/** Acknowledgement for `portfolio:subscribe`. `subscribed: false` means the
 * socket was already subscribed to this portfolio (idempotent duplicate). */
export type PortfolioSubscribeAck =
  | { ok: true; portfolioId: string; subscribed: boolean }
  | { ok: false; error: PortfolioSocketError };

/**
 * Acknowledgement for `portfolio:unsubscribe`. Unsubscribing from a portfolio
 * the socket is not subscribed to still succeeds (idempotent) and the response
 * reveals nothing beyond the portfolioId the caller supplied.
 */
export type PortfolioUnsubscribeAck =
  | { ok: true; portfolioId: string }
  | { ok: false; error: PortfolioSocketError };

/** The one valuation pushed per successful subscription in this slice. */
export interface PortfolioValuationEvent {
  portfolioId: string;
  /** ISO timestamp of when the server computed/emitted this valuation. */
  emittedAt: string;
  /** The exact REST valuation payload — same DTO, same decimal formatting. */
  valuation: PortfolioValuationDto;
}

/** Code carried on the Socket.IO handshake `connect_error` (never `portfolio:error`). */
export type PortfolioConnectErrorCode = 'UNAUTHORIZED';

/**
 * Per-socket state attached by the gateway after a successful handshake.
 *
 * Only the verified identity and its transient access token live here. The
 * access token is the gateway's per-socket authenticated data (kept only here,
 * never in the subscription registry). Subscription bookkeeping no longer
 * lives on `socket.data`: `RealtimeSubscriptionService` is the authoritative
 * registry, keyed by socket id.
 */
export interface PortfolioSocketData {
  userId: string;
  accessToken: string;
}

/** Typed client → server event map (the acknowledged subscribe/unsubscribe). */
export interface PortfolioClientToServerEvents {
  [PORTFOLIO_SUBSCRIBE_EVENT]: (
    payload: SubscribePortfolioPayload,
    ack?: (response: PortfolioSubscribeAck) => void,
  ) => void;
  [PORTFOLIO_UNSUBSCRIBE_EVENT]: (
    payload: SubscribePortfolioPayload,
    ack?: (response: PortfolioUnsubscribeAck) => void,
  ) => void;
}

/** Typed server → client event map. */
export interface PortfolioServerToClientEvents {
  [PORTFOLIO_VALUATION_EVENT]: (payload: PortfolioValuationEvent) => void;
  [PORTFOLIO_ERROR_EVENT]: (payload: PortfolioSocketError) => void;
}

/** The socket type used by the gateway and by typed e2e clients. */
export type PortfolioSocket = Socket<
  PortfolioClientToServerEvents,
  PortfolioServerToClientEvents,
  Record<string, never>,
  PortfolioSocketData
>;

/**
 * A private, server-generated room for one portfolio belonging to one user.
 * The room name is derived from the *authenticated* identity — never from a
 * client payload — so sockets for two different users can never share a room.
 */
export function portfolioRoom(userId: string, portfolioId: string): string {
  return `portfolio:${userId}:${portfolioId}`;
}

/**
 * Exact live price for each symbol successfully priced in one refresh cycle.
 *
 * Values are `Decimal`, never a JS `number`: the provider's numeric price is
 * converted exactly once at the market boundary and every later phase reuses
 * that same value, so no precision is lost or re-derived downstream (the
 * valuation computation consumes it directly as `currentPrice`).
 *
 * Created fresh for each cycle and treated as immutable by its consumers —
 * including the callers that share one coalesced cycle. `ReadonlyMap` is a
 * compile-time guarantee only; entries are normalized symbols.
 */
export type SymbolPriceMap = ReadonlyMap<string, Decimal>;

/**
 * Outcome of one price-refresh cycle.
 *
 * Partial failure is a normal shape here, not an error: a symbol that could not
 * be priced is reported in `failedSymbols` while every other symbol's price is
 * still returned. A failed symbol is *omitted* from `prices` rather than
 * defaulted — substituting a zero for a real price would silently corrupt every
 * figure computed from it.
 */
export interface RealtimePriceRefreshResult {
  /** Normalized symbol → exact provider price. Successful symbols only. */
  prices: SymbolPriceMap;
  /** Normalized symbols that could not be priced this cycle, in symbol order. */
  failedSymbols: string[];
}

/**
 * Identity of one active portfolio, as the registry knows it.
 *
 * Both ids are the authenticated ones captured at subscribe time: `userId` from
 * the verified token, `portfolioId` from the validated payload. They are
 * exactly the pair the trusted internal reader requires to prove ownership, so
 * a recalculation cycle can load a portfolio's holdings without an access token
 * ever being in play.
 *
 * Deliberately carries no socket id, room name, or symbol set: who receives a
 * result is a transport concern resolved at broadcast time, and the symbols a
 * cycle must price come from freshly loaded holdings rather than the registry's
 * snapshot.
 */
export interface ActivePortfolioIdentity {
  userId: string;
  portfolioId: string;
}

/**
 * Why one portfolio could not be recomputed in a cycle.
 *
 * A closed, stable vocabulary rather than a carried exception. Results cross
 * into a future broadcast/logging slice, so they must never expose a raw
 * exception object, a PostgREST message, a provider payload, or any credential
 * detail — only one of these four outcomes.
 */
export type PortfolioRecalculationFailureCode =
  | 'PORTFOLIO_NOT_FOUND'
  | 'HOLDINGS_UNAVAILABLE'
  | 'MISSING_PRICE'
  | 'INTERNAL_ERROR';

/** One portfolio successfully recomputed this cycle. */
export interface PortfolioRecalculationSuccess {
  ok: true;
  userId: string;
  portfolioId: string;
  /** Byte-identical to the REST valuation payload for the same inputs. */
  valuation: PortfolioValuationDto;
}

/** One portfolio that could not be recomputed, isolated from every other. */
export interface PortfolioRecalculationFailure {
  ok: false;
  userId: string;
  portfolioId: string;
  code: PortfolioRecalculationFailureCode;
  /**
   * Normalized, deduplicated, sorted symbols this portfolio holds that had no
   * usable price this cycle. Empty unless `code` is `MISSING_PRICE`.
   */
  unpricedSymbols: string[];
}

/**
 * Per-portfolio outcome of one cycle: exactly one entry per identity in the
 * cycle's starting snapshot, in that snapshot's order.
 */
export type PortfolioRecalculationResult =
  PortfolioRecalculationSuccess | PortfolioRecalculationFailure;

/**
 * Outcome of one recalculation cycle.
 *
 * Partial failure is the normal shape, not an error path: a portfolio that
 * could not be recomputed is reported in `results` while every other portfolio's
 * valuation is still returned. `prices` is the one shared price map every
 * successful valuation was computed from — created fresh for this cycle and
 * never retained.
 */
export interface RealtimeRecalculationResult {
  /** Normalized symbol → exact price, for every symbol priced this cycle. */
  prices: SymbolPriceMap;
  /** Normalized symbols that could not be priced at all, sorted. */
  failedSymbols: string[];
  /** One entry per portfolio in the cycle's snapshot, sorted by identity. */
  results: PortfolioRecalculationResult[];
}
