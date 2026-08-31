import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';

/**
 * AlphaPulse-facing error translation for the upstream market-data providers
 * (Twelve Data + Finnhub).
 *
 * Clients of /api/market should understand AlphaPulse errors, never Axios
 * internals or provider-specific error formats. Every function here maps one
 * upstream signal to a Nest HttpException with a neutral, provider-agnostic
 * message and a deliberately chosen HTTP status.
 *
 * We use the built-in exception subclasses (NotFoundException, BadGateway, …)
 * rather than a bare `new HttpException(message, status)` so every error body
 * carries the same `{ statusCode, message, error }` shape.
 */

/** Context used to build messages; `symbol` is the only field surfaced today. */
export interface ProviderErrorContext {
  symbol: string;
}

/** True when Axios aborted the request because of our configured timeout. */
export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof AxiosError &&
    (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
  );
}

/** A well-formed symbol the provider has no market data for → 404. */
export function unknownSymbolException(symbol: string): NotFoundException {
  return new NotFoundException(`No market data for symbol "${symbol}".`);
}

/** The upstream sent a response we cannot interpret → 502. */
export function malformedProviderResponseException(): BadGatewayException {
  return new BadGatewayException(
    'Upstream market data provider returned an invalid response.',
  );
}

/**
 * Translate an HTTP-level failure (an AxiosError, or anything else) into an
 * AlphaPulse-facing HttpException.
 *
 * Only statuses we can classify with confidence are special-cased. A raw
 * provider 400/404 is deliberately NOT treated as "unknown symbol": we only
 * claim that when the provider explicitly says so (Twelve Data error body /
 * Finnhub all-zero quote). A raw 4xx is just as likely to be AlphaPulse
 * constructing a bad upstream request, so it falls into the safe 5xx bucket.
 */
export function toProviderHttpException(
  error: unknown,
  _ctx: ProviderErrorContext,
): HttpException {
  if (error instanceof AxiosError) {
    const status = error.response?.status;

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return rateLimitException();
    }
    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      // Rejected credentials are an AlphaPulse configuration problem, not the
      // client's, so they surface as an internal error.
      return internalException();
    }
    if (isTimeoutError(error)) {
      return timeoutException();
    }
    if (status === undefined) {
      // No HTTP response at all: DNS/connectivity failure or a dropped socket.
      return unavailableException();
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      return unavailableException();
    }
    // Everything else (raw 400/404, other 4xx/5xx) is an upstream failure we
    // cannot classify further from the transport alone.
    return providerFailedException();
  }

  // Not an AxiosError — an unexpected internal failure. Never leak details.
  return internalException();
}

/**
 * Translate a Twelve Data error body (HTTP 200 + {status:'error', code}) into
 * an AlphaPulse-facing HttpException.
 *
 * Unlike a raw HTTP 4xx, the body-level code is Twelve Data explicitly telling
 * us what went wrong, so body-level 400/404 is treated as an unknown symbol.
 */
export function toProviderBodyHttpException(
  payload: { code?: number },
  ctx: ProviderErrorContext,
): HttpException {
  const code = payload.code;

  if (code === HttpStatus.NOT_FOUND || code === HttpStatus.BAD_REQUEST) {
    // Twelve Data documents body 400 ("Invalid value: symbol") and 404
    // ("symbol not found") as its unknown-symbol signal.
    return unknownSymbolException(ctx.symbol);
  }
  if (code === HttpStatus.TOO_MANY_REQUESTS) {
    return rateLimitException();
  }
  if (code === HttpStatus.UNAUTHORIZED || code === HttpStatus.FORBIDDEN) {
    return internalException();
  }
  if (code === HttpStatus.SERVICE_UNAVAILABLE) {
    return unavailableException();
  }
  // Any other body code (500, etc.) is an upstream failure.
  return providerFailedException();
}

/**
 * 429 uses a bare HttpException because this Nest build ships no
 * TooManyRequestsException. We still build the full `{message, error,
 * statusCode}` body via createBody so its shape matches every other error.
 */
function rateLimitException(): HttpException {
  return new HttpException(
    HttpException.createBody(
      'Upstream market data rate limit exceeded. Please retry shortly.',
      'Too Many Requests',
      HttpStatus.TOO_MANY_REQUESTS,
    ),
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function unavailableException(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    'Market data provider is currently unavailable.',
  );
}

function timeoutException(): GatewayTimeoutException {
  return new GatewayTimeoutException('Market data request timed out.');
}

function providerFailedException(): BadGatewayException {
  return new BadGatewayException(
    'Upstream market data provider failed to serve the request.',
  );
}

function internalException(): InternalServerErrorException {
  return new InternalServerErrorException(
    'Unexpected error while fetching market data.',
  );
}
