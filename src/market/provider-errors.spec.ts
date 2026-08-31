import { HttpStatus } from '@nestjs/common';
import { AxiosError, type AxiosResponse } from 'axios';
import {
  isTimeoutError,
  malformedProviderResponseException,
  toProviderBodyHttpException,
  toProviderHttpException,
  unknownSymbolException,
} from './provider-errors';

const ctx = { symbol: 'AAPL' };

/** Build an AxiosError carrying a real HTTP status (no provider body). */
const httpError = (status: number) => {
  const error = new AxiosError('upstream response', 'ERR_BAD_RESPONSE');
  error.response = {
    status,
    data: {},
    statusText: '',
    headers: {},
    config: { headers: {} },
  } as AxiosResponse;
  return error;
};

describe('provider-errors', () => {
  describe('toProviderHttpException (HTTP-level failures)', () => {
    it('maps a provider 429 to AlphaPulse 429', () => {
      const ex = toProviderHttpException(httpError(429), ctx);
      expect(ex.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it.each([401, 403])(
      'maps a provider %s to AlphaPulse 500 (credential/config problem)',
      (status) => {
        const ex = toProviderHttpException(httpError(status), ctx);
        expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      },
    );

    it.each([400, 404])(
      'maps an ambiguous raw provider %s to AlphaPulse 502, not 404',
      (status) => {
        const ex = toProviderHttpException(httpError(status), ctx);
        expect(ex.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
        // We must not claim an unknown symbol without explicit provider evidence.
        expect(ex.message).not.toContain('No market data');
      },
    );

    it.each([500, 502, 504])('maps a provider %s to AlphaPulse 502', (status) => {
      const ex = toProviderHttpException(httpError(status), ctx);
      expect(ex.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    });

    it('maps a provider 503 to AlphaPulse 503', () => {
      const ex = toProviderHttpException(httpError(503), ctx);
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('maps a timeout (ECONNABORTED) to AlphaPulse 504', () => {
      const ex = toProviderHttpException(
        new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED'),
        ctx,
      );
      expect(ex.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    });

    it('maps a network failure (no HTTP response) to AlphaPulse 503', () => {
      const ex = toProviderHttpException(
        new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED'),
        ctx,
      );
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('maps a non-Axios error to AlphaPulse 500 without leaking details', () => {
      const ex = toProviderHttpException(new Error('secret stack'), ctx);
      expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(ex.message).not.toContain('secret stack');
    });
  });

  describe('toProviderBodyHttpException (Twelve Data error body)', () => {
    it.each([400, 404])(
      'maps body code %s to AlphaPulse 404 (explicit unknown-symbol signal)',
      (code) => {
        const ex = toProviderBodyHttpException({ code }, ctx);
        expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(ex.message).toContain('No market data for symbol "AAPL"');
      },
    );

    it('maps body code 429 to AlphaPulse 429', () => {
      const ex = toProviderBodyHttpException({ code: 429 }, ctx);
      expect(ex.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it.each([401, 403])('maps body code %s to AlphaPulse 500', (code) => {
      const ex = toProviderBodyHttpException({ code }, ctx);
      expect(ex.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('maps body code 503 to AlphaPulse 503', () => {
      const ex = toProviderBodyHttpException({ code: 503 }, ctx);
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('maps body code 500 to AlphaPulse 502', () => {
      const ex = toProviderBodyHttpException({ code: 500 }, ctx);
      expect(ex.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    });
  });

  describe('helper exceptions', () => {
    it('unknownSymbolException is a 404', () => {
      expect(unknownSymbolException('NOPE').getStatus()).toBe(
        HttpStatus.NOT_FOUND,
      );
    });

    it('malformedProviderResponseException is a 502', () => {
      expect(malformedProviderResponseException().getStatus()).toBe(
        HttpStatus.BAD_GATEWAY,
      );
    });

    it('isTimeoutError detects ECONNABORTED / ETIMEDOUT only', () => {
      expect(isTimeoutError(new AxiosError('t', 'ECONNABORTED'))).toBe(true);
      expect(isTimeoutError(new AxiosError('t', 'ETIMEDOUT'))).toBe(true);
      expect(isTimeoutError(new AxiosError('t', 'ECONNREFUSED'))).toBe(false);
      expect(isTimeoutError(new Error('plain'))).toBe(false);
    });
  });

  describe('public messages stay neutral', () => {
    it('never names the provider or leaks Axios internals', () => {
      const messages = [
        toProviderHttpException(httpError(500), ctx).message,
        toProviderHttpException(
          new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED'),
          ctx,
        ).message,
        toProviderBodyHttpException({ code: 429 }, ctx).message,
        unknownSymbolException('NOPE').message,
        malformedProviderResponseException().message,
      ];

      for (const message of messages) {
        expect(message).not.toMatch(/Twelve Data|Finnhub/i);
        expect(message).not.toMatch(/AxiosError|ECONNABORTED|timeout of \d+ms/i);
      }
    });
  });
});
