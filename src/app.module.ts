import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { MarketModule } from './market/market.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    // Loads .env into process.env and exposes ConfigService app-wide. The
    // validate() hook fails the bootstrap on missing/invalid configuration.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    HealthModule,
    MarketModule,
  ],
})
export class AppModule {}
