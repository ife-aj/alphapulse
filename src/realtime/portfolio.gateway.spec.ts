import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Server } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import type { AuthUserDto } from '../auth/dto/auth-response.dto';
import type { PortfolioValuationDto } from '../portfolios/dto/valuation-response.dto';
import { PortfolioGateway } from './portfolio.gateway';
import { RealtimeSubscriptionService } from './realtime-subscription.service';
import {
  PORTFOLIO_ERROR_EVENT,
  PORTFOLIO_SUBSCRIBE_EVENT,
  PORTFOLIO_VALUATION_EVENT,
  portfolioRoom,
  type PortfolioSocket,
} from './realtime.types';

describe('PortfolioGateway', () => {
  const SOCKET_ID = 'socket-1';
  const USER_ID = 'user-1';
  const ACCESS_TOKEN = 'access-token-1';
  const PORTFOLIO_ID = '3a6a2f6e-8f38-4b0b-9a66-1f6a2c7c1a6f';

  let gateway: PortfolioGateway;
  let authService: { verifyAccessToken: jest.Mock };
  let subscriptionService: {
    subscribe: jest.Mock;
    unsubscribe: jest.Mock;
    disconnect: jest.Mock;
    confirmActive: jest.Mock;
    rollbackSubscription: jest.Mock;
  };

  const user: AuthUserDto = {
    id: USER_ID,
    email: 'user@example.com',
    emailConfirmed: true,
    fullName: 'User One',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const valuation: PortfolioValuationDto = {
    portfolioId: PORTFOLIO_ID,
    totalInvestedValue: '0.00',
    totalCurrentValue: '0.00',
    totalProfitLoss: '0.00',
    totalReturnPercentage: '0.00',
    holdings: [],
  };

  /** The registry's prepared active result for a successful new subscription. */
  const subscribedResult = {
    kind: 'subscribed',
    attemptId: 1,
    valuation,
  };

  /** A fake socket carrying only what the gateway touches. */
  function makeSocket(overrides: Partial<PortfolioSocket['data']> = {}): {
    socket: PortfolioSocket;
    emit: jest.Mock;
    join: jest.Mock;
    leave: jest.Mock;
  } {
    const emit = jest.fn();
    const join = jest.fn();
    const leave = jest.fn();
    const socket = {
      id: SOCKET_ID,
      data: {
        userId: USER_ID,
        accessToken: ACCESS_TOKEN,
        ...overrides,
      },
      emit,
      join,
      leave,
    } as unknown as PortfolioSocket;
    return { socket, emit, join, leave };
  }

  beforeEach(() => {
    authService = { verifyAccessToken: jest.fn() };
    subscriptionService = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      disconnect: jest.fn(),
      confirmActive: jest.fn().mockReturnValue(true),
      rollbackSubscription: jest.fn(),
    };
    gateway = new PortfolioGateway(
      authService as unknown as AuthService,
      subscriptionService as unknown as RealtimeSubscriptionService,
    );
  });

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  describe('authentication middleware (afterInit)', () => {
    let captured: (
      socket: Partial<PortfolioSocket>,
      next: (error?: Error & { data?: { code: string } }) => void,
    ) => void;
    let next: jest.Mock;

    beforeEach(() => {
      next = jest.fn();
      const server = {
        use: jest.fn((fn: typeof captured) => {
          captured = fn;
        }),
      };
      gateway.afterInit(server as unknown as Server);
      expect(server.use).toHaveBeenCalledTimes(1);
    });

    const handshake = (token?: unknown) => ({ auth: { token } });

    it('rejects a connection with no token (never calls verifyAccessToken)', async () => {
      authService.verifyAccessToken.mockResolvedValue(user);
      captured({ handshake: handshake(undefined) } as never, next);
      await flush();
      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Authentication failed.');
      expect(error.data).toEqual({ code: 'UNAUTHORIZED' });
      expect(authService.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('rejects a connection with an invalid token', async () => {
      authService.verifyAccessToken.mockRejectedValue(
        new Error('Invalid or expired access token.'),
      );
      captured({ handshake: handshake('bad-token') } as never, next);
      await flush();
      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0];
      expect(error.data).toEqual({ code: 'UNAUTHORIZED' });
    });

    it('accepts a valid token and stores only the verified identity on socket.data', async () => {
      authService.verifyAccessToken.mockResolvedValue(user);
      // Socket.IO initialises every socket with `data: {}`; the middleware
      // writes the verified identity onto it. No subscription bookkeeping is
      // attached here — the registry owns that state now.
      const socket: { data: PortfolioSocket['data']; handshake: object } = {
        data: {},
        handshake: handshake(ACCESS_TOKEN),
      };
      captured(socket as never, next);
      await flush();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeUndefined();
      expect(socket.data).toEqual({
        userId: USER_ID,
        accessToken: ACCESS_TOKEN,
      });
      expect(authService.verifyAccessToken).toHaveBeenCalledWith(ACCESS_TOKEN);
    });

    it('rejects a non-string token', async () => {
      captured({ handshake: handshake(12345) } as never, next);
      await flush();
      expect(next.mock.calls[0][0].data).toEqual({ code: 'UNAUTHORIZED' });
      expect(authService.verifyAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('portfolio:subscribe', () => {
    it('rejects a malformed (non-UUID) portfolioId with VALIDATION_ERROR', async () => {
      const { socket } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: 'not-a-uuid' },
        socket,
      );
      expect(ack).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(subscriptionService.subscribe).not.toHaveBeenCalled();
    });

    it('rejects a null / array / non-object payload with VALIDATION_ERROR', async () => {
      const { socket } = makeSocket();
      for (const payload of [null, [], 42, 'portfolioId', { extra: true }]) {
        const ack = await gateway.handleSubscribe(payload, socket);
        expect(ack).toEqual({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
        });
      }
      expect(subscriptionService.subscribe).not.toHaveBeenCalled();
    });

    it('delegates to the registry and emits one initial valuation to the subscribing socket only', async () => {
      subscriptionService.subscribe.mockResolvedValue(subscribedResult);
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      // Lifecycle state is delegated; the registry is the authoritative owner.
      expect(subscriptionService.subscribe).toHaveBeenCalledTimes(1);
      expect(subscriptionService.subscribe).toHaveBeenCalledWith({
        socketId: SOCKET_ID,
        userId: USER_ID,
        accessToken: ACCESS_TOKEN,
        portfolioId: PORTFOLIO_ID,
      });
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      // The gateway confirms the exact attempt is still active before transport.
      expect(subscriptionService.confirmActive).toHaveBeenCalledWith(
        SOCKET_ID,
        USER_ID,
        PORTFOLIO_ID,
        subscribedResult.attemptId,
      );
      expect(join).toHaveBeenCalledTimes(1);
      expect(join).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(socket.data).toEqual({
        userId: USER_ID,
        accessToken: ACCESS_TOKEN,
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const [event, payload] = emit.mock.calls[0];
      expect(event).toBe(PORTFOLIO_VALUATION_EVENT);
      expect(payload.portfolioId).toBe(PORTFOLIO_ID);
      expect(payload.valuation).toBe(valuation);
      expect(new Date(payload.emittedAt).toISOString()).toBe(payload.emittedAt);
    });

    it('acknowledges a duplicate as subscribed:false without joining or emitting', async () => {
      subscriptionService.subscribe.mockResolvedValue({ kind: 'duplicate' });
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('does not join or emit for an obsolete result (attempt cancelled mid-flight)', async () => {
      subscriptionService.subscribe.mockResolvedValue({ kind: 'obsolete' });
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits only for a genuinely active current attempt (skips transport when confirmActive fails)', async () => {
      subscriptionService.subscribe.mockResolvedValue(subscribedResult);
      subscriptionService.confirmActive.mockReturnValue(false);
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('backs out (leaves the room) if the attempt stops being active before emission', async () => {
      subscriptionService.subscribe.mockResolvedValue(subscribedResult);
      // Active before the join, obsolete immediately after it.
      subscriptionService.confirmActive
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      const { socket, emit, join, leave } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).toHaveBeenCalledTimes(1);
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).not.toHaveBeenCalled();
    });

    it('does not double-join or double-emit when a second subscribe races a pending one', async () => {
      let resolveFirst!: (result: typeof subscribedResult) => void;
      const gate = new Promise<typeof subscribedResult>((resolve) => {
        resolveFirst = resolve;
      });
      subscriptionService.subscribe
        .mockReturnValueOnce(gate)
        .mockResolvedValueOnce({ kind: 'duplicate' });

      const { socket, emit, join } = makeSocket();

      // First subscribe suspends on the registry's pending attempt.
      const first = gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      await flush();

      // The registry reports the concurrent second attempt as a duplicate.
      const second = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(second).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();

      // Let the first subscription complete: one join, one valuation event.
      resolveFirst(subscribedResult);
      const firstAck = await first;
      expect(firstAck).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      expect(join).toHaveBeenCalledTimes(1);
      expect(join).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('rolls back only the matching attempt when the room join throws', async () => {
      subscriptionService.subscribe.mockResolvedValue(subscribedResult);
      const { socket, emit, join, leave } = makeSocket();
      join.mockImplementation(() => {
        throw new Error('adapter down');
      });

      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      // Transport failure after activation: matching rollback + neutral error.
      expect(subscriptionService.rollbackSubscription).toHaveBeenCalledTimes(1);
      expect(subscriptionService.rollbackSubscription).toHaveBeenCalledWith(
        SOCKET_ID,
        USER_ID,
        PORTFOLIO_ID,
        subscribedResult.attemptId,
      );
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).not.toHaveBeenCalled();
      expect(ack).toEqual({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
      });
    });

    it('does not join, emit, or roll back when the registry reports a subscribe failure after a retry replaced the attempt', async () => {
      // A second subscribe already replaced the obsolete first attempt, so the
      // first attempt must not be rolled back over the newer one.
      subscriptionService.subscribe.mockResolvedValue({ kind: 'obsolete' });
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(subscriptionService.rollbackSubscription).not.toHaveBeenCalled();
    });

    it('maps a missing/foreign portfolio to PORTFOLIO_NOT_FOUND with a single neutral message', async () => {
      subscriptionService.subscribe.mockRejectedValue(
        new NotFoundException('Portfolio not found.'),
      );
      const { socket } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: false,
        error: { code: 'PORTFOLIO_NOT_FOUND', message: 'Portfolio not found.' },
      });
    });

    it('maps market/provider failures to MARKET_UNAVAILABLE', async () => {
      for (const error of [
        new UnprocessableEntityException('No market data.'),
        new ServiceUnavailableException('provider down'),
        new HttpException('provider error', 502),
      ]) {
        subscriptionService.subscribe.mockRejectedValue(error);
        const { socket, emit, join } = makeSocket();
        const ack = await gateway.handleSubscribe(
          { portfolioId: PORTFOLIO_ID },
          socket,
        );
        expect(ack).toEqual({
          ok: false,
          error: { code: 'MARKET_UNAVAILABLE', message: expect.any(String) },
        });
        expect(join).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      }
    });

    it('maps unexpected failures to INTERNAL_ERROR', async () => {
      subscriptionService.subscribe.mockRejectedValue(
        new Error('boom — not an HttpException'),
      );
      const { socket } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: expect.any(String) },
      });
    });
  });

  describe('portfolio:unsubscribe', () => {
    it('delegates cleanup to the registry and leaves the room', async () => {
      const { socket, leave } = makeSocket();
      const ack = await gateway.handleUnsubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(subscriptionService.unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscriptionService.unsubscribe).toHaveBeenCalledWith(
        SOCKET_ID,
        USER_ID,
        PORTFOLIO_ID,
      );
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(ack).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
    });

    it('is idempotent for a portfolio that is not subscribed (still delegates, reveals nothing)', async () => {
      const { socket, leave } = makeSocket();
      const ack = await gateway.handleUnsubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
      expect(subscriptionService.unsubscribe).toHaveBeenCalledTimes(1);
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
    });

    it('rejects a malformed portfolioId with VALIDATION_ERROR', async () => {
      const { socket } = makeSocket();
      const ack = await gateway.handleUnsubscribe(
        { portfolioId: 'nope' },
        socket,
      );
      expect(ack).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: expect.any(String) },
      });
      expect(subscriptionService.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('disconnect cleanup', () => {
    it('delegates complete socket cleanup to the registry', () => {
      const { socket } = makeSocket();
      gateway.handleDisconnect(socket);
      expect(subscriptionService.disconnect).toHaveBeenCalledTimes(1);
      expect(subscriptionService.disconnect).toHaveBeenCalledWith(SOCKET_ID);
    });

    it('tolerates sockets that never authenticated (registry no-ops)', () => {
      const socket = {} as PortfolioSocket;
      expect(() => gateway.handleDisconnect(socket)).not.toThrow();
      expect(subscriptionService.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('scheduled broadcasts', () => {
    /**
     * A Socket.IO server stub recording the one call the gateway makes. `to`
     * returns the same emitter, mirroring the real chaining.
     */
    function makeServer() {
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const server = { use: jest.fn(), to };
      return { server: server as unknown as Server, to, emit };
    }

    const event = {
      portfolioId: PORTFOLIO_ID,
      emittedAt: '2026-01-01T00:00:00.000Z',
      valuation,
    };

    it('emits one portfolio:valuation to the portfolio room', () => {
      const { server, to, emit } = makeServer();
      gateway.afterInit(server);

      gateway.broadcastValuation(USER_ID, PORTFOLIO_ID, event);

      // One call, addressed to the room derived from the authenticated
      // identity — Socket.IO fans it out to every socket in that room.
      expect(to).toHaveBeenCalledTimes(1);
      expect(to).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(PORTFOLIO_VALUATION_EVENT, event);
    });

    it('emits one sanitized portfolio:error to the portfolio room', () => {
      const { server, to, emit } = makeServer();
      gateway.afterInit(server);
      const error = {
        code: 'MARKET_UNAVAILABLE' as const,
        message: 'Unable to obtain a portfolio valuation right now.',
      };

      gateway.broadcastPortfolioError(USER_ID, PORTFOLIO_ID, error);

      expect(to).toHaveBeenCalledTimes(1);
      expect(to).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(PORTFOLIO_ERROR_EVENT, error);
    });

    it('is a no-op before the WebSocket layer is initialized', () => {
      // No afterInit: a broadcast must not throw (and must not invent a server).
      expect(() =>
        gateway.broadcastValuation(USER_ID, PORTFOLIO_ID, event),
      ).not.toThrow();
      expect(() =>
        gateway.broadcastPortfolioError(USER_ID, PORTFOLIO_ID, {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
        }),
      ).not.toThrow();
    });
  });
});
