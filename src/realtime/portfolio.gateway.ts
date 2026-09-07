import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import { SubscribePortfolioDto } from './dto/subscribe-portfolio.dto';
import {
  PORTFOLIO_SUBSCRIBE_EVENT,
  PORTFOLIO_UNSUBSCRIBE_EVENT,
  PORTFOLIO_VALUATION_EVENT,
  portfolioRoom,
  type PortfolioConnectErrorCode,
  type PortfolioSocket,
  type PortfolioSocketError,
  type PortfolioSocketErrorCode,
  type PortfolioSubscribeAck,
  type PortfolioUnsubscribeAck,
  type PortfolioValuationEvent,
} from './realtime.types';

const AUTH_FAILED_MESSAGE = 'Authentication failed.';
const NOT_FOUND_MESSAGE = 'Portfolio not found.';
const MARKET_UNAVAILABLE_MESSAGE =
  'Unable to obtain a portfolio valuation right now.';
const INTERNAL_MESSAGE = 'An unexpected error occurred.';
const VALIDATION_MESSAGE = 'portfolioId must be a valid UUID.';

/**
 * Authenticated live portfolio valuation over Socket.IO.
 *
 * Authentication happens during the Socket.IO *connection* process: gateway
 * middleware (registered in `afterInit`) verifies the Supabase access token
 * carried in `socket.handshake.auth.token` via `AuthService.verifyAccessToken`
 * and, on success, stores the verified identity on `socket.data`. A rejected
 * handshake surfaces to the client as `connect_error` — the client never
 * reaches the connected state, so no `@SubscribeMessage` handler can ever run
 * for an unauthenticated socket.
 *
 * This slice delivers exactly one initial `portfolio:valuation` per successful
 * subscription. There is no polling, quote cache, symbol reference counting, or
 * stale-price reuse yet; subscriptions are re-valued by reusing the existing
 * `PortfoliosValuationService.getValuation(...)`, which is also the ownership
 * boundary (neutral 404 for missing/foreign portfolios).
 *
 * No CORS is configured here, consistent with the HTTP API, which enables no
 * CORS either (see `src/main.ts`). Cross-origin browser clients are out of
 * scope; same-origin and non-browser clients connect fine.
 */
@WebSocketGateway()
export class PortfolioGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(PortfolioGateway.name);

  constructor(
    private readonly authService: AuthService,
    private readonly valuationService: PortfoliosValuationService,
  ) {}

  /**
   * Register Socket.IO connection middleware so invalid credentials are
   * rejected *before* the connection is established (client sees
   * `connect_error`), and so subscription handlers can never run before the
   * verified identity is stored on `socket.data`.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticateSocket(socket)
        .then(() => next())
        .catch((error: unknown) => {
          this.logAuthFailure(socket, error);
          next(this.connectError());
        });
    });
  }

  /**
   * Concise, neutral log for a rejected handshake. Level matches the cause: a
   * routine missing/invalid token is expected client behaviour (debug); a 5xx
   * from the auth service is an availability problem worth a warning — never a
   * "crash" report per rejected client. Only the socket id is included; the
   * token, handshake auth object, and Supabase internals are never logged, and
   * no user identity is assumed before authentication succeeds.
   */
  private logAuthFailure(socket: Socket, error: unknown): void {
    const isAuthOutage =
      error instanceof HttpException && error.getStatus() >= 500;
    const context = `Socket connection rejected (socket ${socket.id})`;
    if (isAuthOutage) {
      this.logger.warn(`${context}: authentication service unavailable`);
    } else {
      this.logger.debug(`${context}: authentication failed`);
    }
  }

  /**
   * On disconnect there is nothing to clean up globally: subscriptions live on
   * `socket.data.portfolioIds` (garbage-collected with the socket) and Socket.IO
   * automatically removes a socket from every room it joined. Clearing the set
   * here is purely defensive.
   */
  handleDisconnect(socket: PortfolioSocket): void {
    socket.data?.portfolioIds?.clear();
  }

  @SubscribeMessage(PORTFOLIO_SUBSCRIBE_EVENT)
  async handleSubscribe(
    @MessageBody() payload: unknown,
    @ConnectedSocket() socket: PortfolioSocket,
  ): Promise<PortfolioSubscribeAck> {
    const portfolioId = await this.parsePortfolioId(payload);
    if (portfolioId === null) {
      return this.errorAck('VALIDATION_ERROR', VALIDATION_MESSAGE);
    }

    const { userId, accessToken, portfolioIds } = socket.data;

    // Idempotent duplicate: the portfolio is already reserved/subscribed on this
    // socket. Acknowledge success with subscribed:false and do not re-validate,
    // re-join, or value it again.
    if (portfolioIds.has(portfolioId)) {
      return { ok: true, portfolioId, subscribed: false };
    }

    // Reserve the subscription *before* the first await. Reserving up front
    // closes the race where two pipelined subscribe packets for the same
    // portfolio on this socket could both observe an empty set and both call
    // the valuation service. The reservation is released on failure below, so a
    // later legitimate retry can subscribe.
    portfolioIds.add(portfolioId);

    try {
      // Authorization + initial valuation in one call: getValuation verifies the
      // portfolio belongs to this user (neutral 404 otherwise) and computes the
      // exact-decimal valuation, reusing the REST path unchanged. It never runs
      // before the reservation is taken.
      const valuation = await this.valuationService.getValuation(
        userId,
        accessToken,
        portfolioId,
      );

      // Authorization succeeded — only now join the private, server-generated
      // room for (user, portfolio) and push the one initial valuation to the
      // subscribing socket only.
      socket.join(portfolioRoom(userId, portfolioId));

      const event: PortfolioValuationEvent = {
        portfolioId,
        emittedAt: new Date().toISOString(),
        valuation,
      };
      socket.emit(PORTFOLIO_VALUATION_EVENT, event);
      this.logger.debug(
        `Subscribed socket ${socket.id} to portfolio ${portfolioId} for user ${userId}`,
      );

      return { ok: true, portfolioId, subscribed: true };
    } catch (error) {
      // Valuation/authorization/join failed: release the reservation so a later
      // retry can subscribe, and leave the room defensively (a Socket.IO no-op
      // if the join never happened).
      portfolioIds.delete(portfolioId);
      socket.leave(portfolioRoom(userId, portfolioId));
      const mapped = this.mapValuationError(error);
      this.logSubscribeFailure(error, mapped, userId, portfolioId);
      return { ok: false, error: mapped };
    }
  }

  @SubscribeMessage(PORTFOLIO_UNSUBSCRIBE_EVENT)
  async handleUnsubscribe(
    @MessageBody() payload: unknown,
    @ConnectedSocket() socket: PortfolioSocket,
  ): Promise<PortfolioUnsubscribeAck> {
    const portfolioId = await this.parsePortfolioId(payload);
    if (portfolioId === null) {
      return this.errorAck('VALIDATION_ERROR', VALIDATION_MESSAGE);
    }

    const { userId, portfolioIds } = socket.data;
    // Idempotent: removing a portfolio that was not subscribed is a success and
    // reveals nothing about whether it was tracked. Leaving a room the socket is
    // not in is a Socket.IO no-op.
    portfolioIds.delete(portfolioId);
    socket.leave(portfolioRoom(userId, portfolioId));
    return { ok: true, portfolioId };
  }

  /** Verify the handshake token and attach the identity to `socket.data`. */
  private async authenticateSocket(socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (token === null) {
      throw new Error('Missing access token');
    }
    // verifyAccessToken is the single source of token validation rules — never
    // re-implemented here. It is called once per connection, not per subscribe.
    const user = await this.authService.verifyAccessToken(token);
    const authenticated = socket as unknown as PortfolioSocket;
    authenticated.data.userId = user.id;
    authenticated.data.accessToken = token;
    authenticated.data.portfolioIds = new Set<string>();
  }

  private extractToken(socket: Socket): string | null {
    const auth = socket.handshake.auth;
    if (auth === null || typeof auth !== 'object') {
      return null;
    }
    const token = (auth as { token?: unknown }).token;
    if (typeof token !== 'string' || token.trim() === '') {
      return null;
    }
    return token;
  }

  /** The error surfaced to the client as Socket.IO `connect_error`. */
  private connectError(): Error & {
    data: { code: PortfolioConnectErrorCode };
  } {
    const error = new Error(AUTH_FAILED_MESSAGE) as Error & {
      data: { code: PortfolioConnectErrorCode };
    };
    error.data = { code: 'UNAUTHORIZED' };
    return error;
  }

  private async parsePortfolioId(payload: unknown): Promise<string | null> {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return null;
    }
    const dto = plainToInstance(SubscribePortfolioDto, payload);
    const errors = await validate(dto);
    return errors.length === 0 ? dto.portfolioId : null;
  }

  /**
   * Log a failed subscription/initial valuation with neutral context only — no
   * token, headers, provider URLs/bodies, credentials, or valuation contents.
   * Level matches the mapped outcome: a missing/foreign portfolio is an expected
   * neutral 404 (debug); provider/service failures are visible (warn); anything
   * unexpected logs at error with the server-side message for diagnosis.
   */
  private logSubscribeFailure(
    error: unknown,
    mapped: PortfolioSocketError,
    userId: string,
    portfolioId: string,
  ): void {
    const status =
      error instanceof HttpException ? error.getStatus() : undefined;
    const errorName =
      error && typeof error === 'object' && error.constructor
        ? error.constructor.name
        : typeof error;
    const context = `Subscription to portfolio ${portfolioId} by user ${userId} failed (${mapped.code}, ${errorName}${status === undefined ? '' : `, http ${status}`})`;

    if (mapped.code === 'PORTFOLIO_NOT_FOUND') {
      // Missing or foreign portfolio is an expected, neutral outcome.
      this.logger.debug(context);
    } else if (mapped.code === 'MARKET_UNAVAILABLE') {
      this.logger.warn(context);
    } else {
      // Unexpected server failure — include the message server-side only.
      this.logger.error(
        error instanceof Error ? `${context}: ${error.message}` : context,
      );
    }
  }

  private mapValuationError(error: unknown): PortfolioSocketError {
    if (error instanceof NotFoundException) {
      return { code: 'PORTFOLIO_NOT_FOUND', message: NOT_FOUND_MESSAGE };
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const isMarketOrValuationFailure =
        status === HttpStatus.UNPROCESSABLE_ENTITY || // no market data for a held symbol
        status === HttpStatus.TOO_MANY_REQUESTS || // provider rate limited
        status === HttpStatus.INTERNAL_SERVER_ERROR || // provider credential/config problem
        status === HttpStatus.BAD_GATEWAY || // provider transport failure
        status === HttpStatus.SERVICE_UNAVAILABLE || // provider unavailable
        status === HttpStatus.GATEWAY_TIMEOUT; // provider timeout
      if (isMarketOrValuationFailure) {
        return {
          code: 'MARKET_UNAVAILABLE',
          message: MARKET_UNAVAILABLE_MESSAGE,
        };
      }
    }
    return { code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE };
  }

  private errorAck(
    code: PortfolioSocketErrorCode,
    message: string,
  ): { ok: false; error: PortfolioSocketError } {
    return { ok: false, error: { code, message } };
  }
}
