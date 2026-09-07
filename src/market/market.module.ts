import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MarketController } from './market.controller';
import { MarketService, TWELVE_DATA_HTTP } from './market.service';
import { IndicatorsController } from './indicators/indicators.controller';
import { IndicatorsService } from './indicators/indicators.service';
import { SignalsController } from './signals/signals.controller';
import { SignalsService } from './signals/signals.service';

/**
 * Outbound timeout (ms) for market-data provider requests. Env-tunable via
 * MARKET_PROVIDER_TIMEOUT_MS so a slow provider can never pin a request open
 * indefinitely; applied to both the Finnhub and Twelve Data clients.
 */
function providerTimeoutMs(config: ConfigService): number {
  const raw = Number(config.get<string>('MARKET_PROVIDER_TIMEOUT_MS') ?? '5000');
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

@Module({
  imports: [
    // Configure the axios instance once: Finnhub base URL + auth header.
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseURL:
          config.get<string>('FINNHUB_BASE_URL') ?? 'https://finnhub.io/api/v1',
        timeout: providerTimeoutMs(config),
        headers: {
          'X-Finnhub-Token': config.get<string>('FINNHUB_API_KEY') ?? '',
        },
      }),
    }),
  ],
  controllers: [MarketController, IndicatorsController, SignalsController],
  providers: [
    MarketService,
    IndicatorsService,
    SignalsService,
    {
      // A dedicated axios client for Twelve Data (historical candles),
      // separate from the Finnhub-configured HttpService above.
      provide: TWELVE_DATA_HTTP,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        axios.create({
          baseURL:
            config.get<string>('TWELVE_DATA_BASE_URL') ??
            'https://api.twelvedata.com',
          timeout: providerTimeoutMs(config),
        }),
    },
  ],
  // MarketService is consumed by feature modules (e.g. live portfolio
  // valuation) so it must be exported; nothing else about MarketModule changes.
  exports: [MarketService],
})
export class MarketModule {}
