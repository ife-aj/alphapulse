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
import { PortfoliosValuationService } from '../portfolios/portfolio-valuation.service';
import { PortfolioGateway } from './portfolio.gateway';
import {
  PORTFOLIO_SUBSCRIBE_EVENT,
  PORTFOLIO_VALUATION_EVENT,
  portfolioRoom,
  type PortfolioSocket,
} from './realtime.types';

describe('PortfolioGateway', () => {
  const USER_ID = 'user-1';
  const ACCESS_TOKEN = 'access-token-1';
  const PORTFOLIO_ID = '3a6a2f6e-8f38-4b0b-9a66-1f6a2c7c1a6f';

  let gateway: PortfolioGateway;
  let authService: { verifyAccessToken: jest.Mock };
  let valuationService: { getValuation: jest.Mock };

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
      data: {
        userId: USER_ID,
        accessToken: ACCESS_TOKEN,
        portfolioIds: new Set<string>(),
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
    valuationService = { getValuation: jest.fn() };
    gateway = new PortfolioGateway(
      authService as unknown as AuthService,
      valuationService as unknown as PortfoliosValuationService,
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

    it('accepts a valid token and stores the verified identity on socket.data', async () => {
      authService.verifyAccessToken.mockResolvedValue(user);
      // Socket.IO initialises every socket with `data: {}`; the middleware
      // writes the verified identity onto it.
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
        portfolioIds: expect.any(Set),
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
      expect(valuationService.getValuation).not.toHaveBeenCalled();
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
      expect(valuationService.getValuation).not.toHaveBeenCalled();
    });

    it('subscribes to an owned portfolio and emits one initial valuation to the subscribing socket only', async () => {
      valuationService.getValuation.mockResolvedValue(valuation);
      const { socket, emit, join } = makeSocket();
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(valuationService.getValuation).toHaveBeenCalledTimes(1);
      expect(valuationService.getValuation).toHaveBeenCalledWith(
        USER_ID,
        ACCESS_TOKEN,
        PORTFOLIO_ID,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      expect(join).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(socket.data.portfolioIds.has(PORTFOLIO_ID)).toBe(true);
      expect(emit).toHaveBeenCalledTimes(1);
      const [event, payload] = emit.mock.calls[0];
      expect(event).toBe(PORTFOLIO_VALUATION_EVENT);
      expect(payload.portfolioId).toBe(PORTFOLIO_ID);
      expect(payload.valuation).toBe(valuation);
      expect(new Date(payload.emittedAt).toISOString()).toBe(payload.emittedAt);
    });

    it('is idempotent for a duplicate subscription (no re-validation or re-join)', async () => {
      valuationService.getValuation.mockResolvedValue(valuation);
      const { socket, join } = makeSocket({
        portfolioIds: new Set([PORTFOLIO_ID]),
      });
      const ack = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(valuationService.getValuation).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
    });

    it('reserves the portfolio before the first await so two concurrent subscribes cannot both value it', async () => {
      let resolveValuation!: (value: PortfolioValuationDto) => void;
      const gate = new Promise<PortfolioValuationDto>((resolve) => {
        resolveValuation = resolve;
      });
      valuationService.getValuation.mockReturnValue(gate);

      const { socket, emit, join } = makeSocket();

      // Start the first subscribe: it validates, reserves the portfolio, then
      // suspends on the still-pending getValuation.
      const first = gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      await flush();

      // Start the second subscribe before the first valuation resolves.
      const second = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );

      // The up-front reservation made the second a duplicate — no second
      // valuation/authorization pass and no emission yet.
      expect(second).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: false,
      });
      expect(valuationService.getValuation).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();

      // Let the first subscription complete: one join, one valuation event.
      resolveValuation(valuation);
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

    it('releases the reservation on failure so a later legitimate retry can subscribe', async () => {
      const { socket, emit, join, leave } = makeSocket();

      valuationService.getValuation.mockRejectedValueOnce(
        new ServiceUnavailableException('provider down'),
      );
      const failed = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(failed).toEqual({
        ok: false,
        error: { code: 'MARKET_UNAVAILABLE', message: expect.any(String) },
      });
      // The reservation is gone and the room is left defensively.
      expect(socket.data.portfolioIds.has(PORTFOLIO_ID)).toBe(false);
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();

      // A later retry is no longer a duplicate — it re-validates and succeeds.
      valuationService.getValuation.mockResolvedValue(valuation);
      const retry = await gateway.handleSubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(retry).toEqual({
        ok: true,
        portfolioId: PORTFOLIO_ID,
        subscribed: true,
      });
      expect(valuationService.getValuation).toHaveBeenCalledTimes(2);
      expect(join).toHaveBeenCalledTimes(1);
      expect(join).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('maps a missing/foreign portfolio to PORTFOLIO_NOT_FOUND with a single neutral message', async () => {
      // The gateway never inspects the cause beyond NotFoundException, so a
      // missing portfolio and another user's portfolio (both throw it from the
      // valuation service) produce the identical, neutral response — no
      // existence leak.
      valuationService.getValuation.mockRejectedValue(
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
        valuationService.getValuation.mockRejectedValue(error);
        const { socket } = makeSocket();
        const ack = await gateway.handleSubscribe(
          { portfolioId: PORTFOLIO_ID },
          socket,
        );
        expect(ack).toEqual({
          ok: false,
          error: { code: 'MARKET_UNAVAILABLE', message: expect.any(String) },
        });
        expect(socket.data.portfolioIds.has(PORTFOLIO_ID)).toBe(false);
      }
    });

    it('maps unexpected failures to INTERNAL_ERROR', async () => {
      valuationService.getValuation.mockRejectedValue(
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
    it('unsubscribes from a subscribed portfolio', async () => {
      const { socket, leave } = makeSocket({
        portfolioIds: new Set([PORTFOLIO_ID]),
      });
      const ack = await gateway.handleUnsubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
      expect(socket.data.portfolioIds.has(PORTFOLIO_ID)).toBe(false);
      expect(leave).toHaveBeenCalledWith(portfolioRoom(USER_ID, PORTFOLIO_ID));
    });

    it('is idempotent for a portfolio that is not subscribed', async () => {
      const { socket, leave } = makeSocket();
      const ack = await gateway.handleUnsubscribe(
        { portfolioId: PORTFOLIO_ID },
        socket,
      );
      expect(ack).toEqual({ ok: true, portfolioId: PORTFOLIO_ID });
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
    });
  });

  describe('disconnect cleanup', () => {
    it('clears every tracked subscription', () => {
      const { socket } = makeSocket({
        portfolioIds: new Set([PORTFOLIO_ID, 'other-uuid']),
      });
      gateway.handleDisconnect(socket);
      expect(socket.data.portfolioIds.size).toBe(0);
    });

    it('tolerates sockets that never authenticated', () => {
      const socket = {} as PortfolioSocket;
      expect(() => gateway.handleDisconnect(socket)).not.toThrow();
    });
  });
});
