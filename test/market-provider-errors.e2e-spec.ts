import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import request from 'supertest';
import { App } from 'supertest/types';
import { AxiosError, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { AppModule } from './../src/app.module';
import { TWELVE_DATA_HTTP } from './../src/market/market.service';

/**
 * Provider-failure behavior end-to-end. Both upstream HTTP clients are
 * overridden with mocks, so no live Twelve Data / Finnhub request is ever
 * made. These tests prove the HTTP status + public body shape a real client
 * receives, and that no Axios/provider internals leak into the response.
 */

const finnhubQuote = (overrides: Record<string, unknown> = {}) => ({
  c: 100,
  d: 2,
  dp: 2.04,
  h: 101,
  l: 98,
  o: 99,
  pc: 98,
  t: 1582641000,
  ...overrides,
});

const asAxiosResponse = <T>(data: T, status = 200): AxiosResponse =>
  ({
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: { headers: {} },
  }) as unknown as AxiosResponse;

const httpError = (status: number) => {
  const error = new AxiosError('upstream response', 'ERR_BAD_RESPONSE');
  error.response = asAxiosResponse({}, status);
  return error;
};

describe('Market provider error handling (e2e)', () => {
  let app: INestApplication<App>;
  const httpService = { get: jest.fn() };
  const twelveData = { get: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpService)
      .overrideProvider(TWELVE_DATA_HTTP)
      .useValue(twelveData)
      .compile();

    app = moduleFixture.createNestApplication();
    // Mirror the production bootstrap in main.ts.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 with a clean AlphaPulse body for an unknown symbol', async () => {
    // Finnhub reports unknown symbols as a 200 with all-zero fields.
    httpService.get.mockReturnValue(
      of(asAxiosResponse(finnhubQuote({ c: 0, t: 0 }))),
    );

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=NOPE')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toEqual({
          statusCode: 404,
          message: 'No market data for symbol "NOPE".',
          error: 'Not Found',
        });
      });
  });

  it('returns 429 for a provider rate limit', async () => {
    httpService.get.mockReturnValue(throwError(() => httpError(429)));

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=AAPL')
      .expect(429)
      .expect(({ body }) => {
        // 429 also carries the full {statusCode, message, error} shape.
        expect(body).toHaveProperty('statusCode', 429);
        expect(body).toHaveProperty('error', 'Too Many Requests');
      });
  });

  it('returns 502 for a provider 500', async () => {
    httpService.get.mockReturnValue(throwError(() => httpError(500)));

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=AAPL')
      .expect(502);
  });

  it('returns 503 for a network failure', async () => {
    httpService.get.mockReturnValue(
      throwError(() => new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED')),
    );

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=AAPL')
      .expect(503);
  });

  it('returns 504 for a provider timeout', async () => {
    httpService.get.mockReturnValue(
      throwError(
        () => new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED'),
      ),
    );

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=AAPL')
      .expect(504);
  });

  it('returns 404 for an empty Twelve Data candle response', async () => {
    twelveData.get.mockResolvedValue(asAxiosResponse({ status: 'ok', values: [] }));

    return request(app.getHttpServer())
      .get('/api/market/candles/AAPL')
      .expect(404)
      .expect(({ body }) => {
        expect(body).toHaveProperty('message', 'No market data for symbol "AAPL".');
      });
  });

  it('never leaks Axios internals or provider secrets in error bodies', async () => {
    httpService.get.mockReturnValue(
      throwError(
        () => new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED'),
      ),
    );

    return request(app.getHttpServer())
      .get('/api/market/quotes?symbols=AAPL')
      .expect(504)
      .expect(({ body }) => {
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain('AxiosError');
        expect(serialized).not.toContain('ECONNABORTED');
        expect(serialized).not.toContain('timeout of');
        expect(serialized).not.toContain('apikey');
        expect(serialized).not.toContain('Finnhub');
        expect(serialized).not.toContain('stack');
      });
  });
});
