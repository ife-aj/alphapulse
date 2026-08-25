import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { MarketModule } from './market/market.module';

@Module({
  imports: [
    // Loads .env into process.env and exposes ConfigService app-wide.
    ConfigModule.forRoot({ isGlobal: true }),
    HealthModule,
    MarketModule,
  ],
})
export class AppModule {}
