import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Symbol validation (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

  // ParseSymbolPipe runs before the handler, so an invalid symbol is a 400 and
  // no upstream provider call is ever made. 'BRK-B' uses Yahoo's hyphen
  // convention; our providers (Finnhub/Twelve Data) expect 'BRK.B'.
  it('rejects an invalid :symbol with HTTP 400', () => {
    return request(app.getHttpServer())
      .get('/api/market/candles/BRK-B')
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});
