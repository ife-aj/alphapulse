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

@Module({
  imports: [
    // Configure the axios instance once: Finnhub base URL + auth header.
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseURL:
          config.get<string>('FINNHUB_BASE_URL') ?? 'https://finnhub.io/api/v1',
        timeout: 5000,
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
          timeout: 5000,
        }),
    },
  ],
})
export class MarketModule {}
